//! Classic session topics. One serialized reconciler, stable write-before-HTTP
//! creation receipts, and replay-safe title edits; no provider activation.
use super::{
    admission::authorize_workspace,
    api::BotApi,
    runtime::{pause, AdapterError, Context},
    types::{ChatId, TopicKey},
};
use crate::domain::{
    error::DomainError,
    fork::ContentHash,
    query::{ListCursor, SessionSummary},
    OperationId, SessionId,
};
use tokio_util::sync::CancellationToken;

pub(crate) type Locks = std::sync::Arc<
    tokio::sync::Mutex<
        std::collections::BTreeMap<SessionId, std::sync::Arc<tokio::sync::Mutex<()>>>,
    >,
>;

pub(super) fn title(summary: &SessionSummary) -> String {
    let text = format!(
        "#{} · {}",
        summary.created_seq.get(),
        summary
            .title
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("新对话")
    );
    let mut units = 0;
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take_while(|c| {
            units += c.len_utf16();
            units <= 128
        })
        .collect()
}

pub(crate) fn operation(chat: ChatId, session: &SessionId) -> Result<OperationId, DomainError> {
    Ok(OperationId::new(format!(
        "session-topic-{}-{}",
        chat.get(),
        ContentHash::of(session.as_str()).as_str()
    ))?)
}

pub(super) async fn ensure(
    context: &Context<impl BotApi>,
    chat: ChatId,
    session: &SessionId,
) -> Result<TopicKey, DomainError> {
    let gate = {
        let mut gates = context.topics.lock().await;
        // Retain only in-flight cells. A slow topic must not serialize other
        // sessions, nor may the cache grow with all historical sessions.
        gates.retain(|_, gate| std::sync::Arc::strong_count(gate) > 1);
        gates.entry(session.clone()).or_default().clone()
    };
    let _serial = gate.lock().await;
    if !context.config.allowed_chat_ids.contains(&chat) {
        return Err(DomainError::OperationConflict);
    }
    let summary = context
        .app
        .database()
        .summary(session.clone())
        .await
        .map_err(|e| DomainError::Persistence(e.to_string()))?;
    if authorize_workspace(&summary.cwd, &context.config.workspace).await? != summary.cwd {
        return Err(DomainError::OperationConflict);
    }
    let topic = if let Some(topic) = context.store.topic(session).await? {
        if topic.chat != chat {
            return Err(DomainError::OperationConflict);
        }
        topic
    } else {
        // Stable initial name means a title update between creation and binding
        // cannot change the effect fingerprint or create a duplicate topic.
        let name = format!("#{} · 新对话", summary.created_seq.get());
        let thread = context
            .effects
            .create_topic(operation(chat, session)?, &context.api, chat, name)
            .await?;
        let current = context
            .inspect(session)
            .await?
            .ok_or_else(|| DomainError::NotFound(session.clone()))?;
        if current.cwd != summary.cwd {
            return Err(DomainError::OperationConflict);
        }
        let topic = TopicKey {
            chat,
            thread: Some(thread),
        };
        context
            .store
            .bind_available(topic.clone(), session.clone())
            .await?;
        topic
    };
    if let Some(thread) = topic.thread {
        let name = title(&summary);
        context
            .effects
            .rename_topic(&context.api, chat, thread, name)
            .await?;
    }
    Ok(topic)
}

pub(super) async fn reconcile(
    context: &Context<impl BotApi>,
    chat: ChatId,
    cursor: Option<ListCursor>,
) -> Result<(Option<ListCursor>, bool), DomainError> {
    let page = context.app.list(cursor, Some(20)).await?;
    let mut pending = false;
    for item in page.sessions {
        if authorize_workspace(&item.cwd, &context.config.workspace)
            .await
            .is_err()
        {
            continue;
        }
        if context
            .store
            .topic(&item.id)
            .await?
            .is_some_and(|t| t.chat != chat)
        {
            continue;
        }
        // An uncertain creation stays fenced by its original receipt; continue
        // scanning other sessions rather than blocking their independent topics.
        if ensure(context, chat, &item.id).await.is_err() {
            pending = true;
        }
    }
    Ok((page.next_cursor, pending))
}

pub(super) async fn run(
    context: Context<impl BotApi>,
    stop: CancellationToken,
) -> Result<(), AdapterError> {
    // Legacy had one configured forum. Never silently choose among multiple
    // allowed forums or send sessions into a private/non-forum chat.
    let chat = loop {
        let mut forums = vec![];
        let mut uncertain = false;
        for chat in &context.config.allowed_chat_ids {
            if chat.get() >= 0 {
                continue;
            }
            let forum = tokio::select! { _=stop.cancelled()=>return Ok(()), result=context.api.forum_chat(*chat)=>result };
            match forum {
                Ok(true) => forums.push(*chat),
                Ok(false) => {}
                Err(_) => uncertain = true,
            }
        }
        if !uncertain && forums.len() == 1 {
            context
                .auto_forum
                .store(forums[0].get(), std::sync::atomic::Ordering::Release);
            break forums[0];
        }
        context.auto_forum.store(
            if uncertain { 0 } else { i64::MAX },
            std::sync::atomic::Ordering::Release,
        );
        if !pause(&stop, std::time::Duration::from_secs(30)).await {
            return Ok(());
        }
    };
    let mut cursor = None;
    loop {
        if stop.is_cancelled() || context.app.is_closing() {
            return Ok(());
        }
        let (next, pending) = reconcile(&context, chat, cursor).await?;
        cursor = next;
        if !pause(
            &stop,
            std::time::Duration::from_secs(if pending { 30 } else { 1 }),
        )
        .await
        {
            return Ok(());
        }
    }
}
