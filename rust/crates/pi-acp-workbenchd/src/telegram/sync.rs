//! Bounded sync pages, immutable plan and the existing topic effect/outbox.
use super::{
    admission::authorize_workspace,
    api::BotApi,
    runtime::Context,
    state::InboxRecord,
    types::{TopicKey, UpdateId},
};
use crate::{
    domain::{
        error::DomainError,
        fork::ContentHash,
        query::{ListCursor, SafeInteger},
        NoticeId, OperationId, SessionId, WorkspacePath,
    },
    persistence::{inbox::HistoryExport, payload::NoticeContent},
};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Item {
    pub session: SessionId,
    pub cwd: WorkspacePath,
    pub max_seq: SafeInteger,
    pub limit: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Plan {
    pub items: Vec<Item>,
    next: Option<ListCursor>,
    recent: u8,
    forum: bool,
}
pub(crate) fn plan_id(id: UpdateId) -> Result<NoticeId, DomainError> {
    Ok(NoticeId::new(format!("sync-plan-{}", id.get()))?)
}
pub(crate) fn result_id(id: UpdateId, session: &SessionId) -> Result<NoticeId, DomainError> {
    Ok(NoticeId::new(format!(
        "sync-result-{}-{}",
        id.get(),
        ContentHash::of(session.as_str()).as_str()
    ))?)
}
pub(super) async fn run(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    cursor: &Option<ListCursor>,
    mut recent: u8,
    forum: bool,
) -> Result<String, DomainError> {
    let payloads = context.app.delivery_payloads();
    let reply = NoticeId::new(format!("menu-reply-{}", record.id.get()))?;
    if let Some(saved) = payloads.find_notice(&reply).await? {
        return Ok(saved.text);
    }
    let id = plan_id(record.id)?;
    let plan = if let Some(saved) = payloads.find_notice(&id).await? {
        serde_json::from_str::<Plan>(&saved.text)
            .map_err(|_| DomainError::Persistence("invalid sync plan".into()))?
    } else {
        if recent > 5 {
            return Err(DomainError::InvalidAnswer(
                "invalid sync recent budget".into(),
            ));
        }
        let (sources, next) = if forum {
            let page = context.app.list_activity(cursor.clone(), Some(10)).await?;
            (
                page.sessions
                    .into_iter()
                    .map(|item| item.id)
                    .collect::<Vec<_>>(),
                page.next_cursor,
            )
        } else {
            (
                vec![context
                    .store
                    .binding(&record.command.topic)
                    .await?
                    .ok_or_else(|| {
                        DomainError::InvalidAnswer("bind a session before private-chat sync".into())
                    })?],
                None,
            )
        };
        let mut items = vec![];
        for session in sources {
            let Some(view) = context.inspect(&session).await? else {
                continue;
            };
            if !matches!(authorize_workspace(&view.cwd, &context.config.workspace).await, Ok(ref canonical) if canonical == &view.cwd)
            {
                if !forum {
                    return Err(DomainError::InvalidAnswer(
                        "sync workspace forbidden".into(),
                    ));
                }
                continue;
            }
            if context
                .store
                .topic(&session)
                .await?
                .is_some_and(|topic| topic.chat != record.command.topic.chat)
            {
                continue;
            }
            let limit = if recent > 0 {
                recent -= 1;
                10
            } else {
                2
            };
            items.push(Item {
                session,
                cwd: view.cwd,
                max_seq: view.last_entry_seq,
                limit,
            });
        }
        let plan = Plan {
            items,
            next,
            recent,
            forum,
        };
        let text = serde_json::to_string(&plan)
            .map_err(|_| DomainError::Persistence("sync encoding failed".into()))?;
        if text.len() > 32 * 1024 {
            return Err(DomainError::Backpressure);
        }
        payloads.put_notice(&NoticeContent { id, text }).await?;
        plan
    };
    let mut text = String::from("Sync: sessions by recent committed activity, chronological entries per session, 10 sessions per stable activity-watermark page. Five newest accessible sessions: up to 10 entries each; older: up to 2. Scan cap 200/session; no Thoughts or raw tool text.\n");
    for item in &plan.items {
        if payloads
            .find_notice(&result_id(record.id, &item.session)?)
            .await?
            .is_some()
        {
            text.push_str(&format!("{}: original export recovered\n", item.session));
            continue;
        }
        if authorize_workspace(&item.cwd, &context.config.workspace).await? != item.cwd {
            return Err(DomainError::OperationConflict);
        }
        let view = context
            .inspect(&item.session)
            .await?
            .ok_or_else(|| DomainError::NotFound(item.session.clone()))?;
        if view.cwd != item.cwd {
            return Err(DomainError::OperationConflict);
        }
        let destination = match context.store.topic(&item.session).await? {
            Some(topic) if topic.chat == record.command.topic.chat => topic,
            Some(_) => return Err(DomainError::OperationConflict),
            None if plan.forum => {
                // Shared across sync requests: concurrent retries cannot create
                // a second topic. An uncertain effect needs explicit repair.
                let key = format!(
                    "sync-topic-{}-{}",
                    record.command.topic.chat.get(),
                    ContentHash::of(item.session.as_str()).as_str()
                );
                let name = format!(
                    "{:?}: {}",
                    view.harness,
                    item.cwd
                        .as_ref()
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("workspace")
                )
                .chars()
                .take(100)
                .collect();
                let thread = context
                    .effects
                    .create_topic(
                        OperationId::new(key)?,
                        &context.api,
                        record.command.topic.chat,
                        name,
                    )
                    .await?;
                let topic = TopicKey {
                    chat: record.command.topic.chat,
                    thread: Some(thread),
                };
                context
                    .store
                    .bind_available(topic.clone(), item.session.clone())
                    .await?;
                topic
            }
            None => return Err(DomainError::OperationConflict),
        };
        context
            .store
            .sync_reply(
                HistoryExport {
                    topic: destination,
                    update: record.id,
                    session: item.session.clone(),
                    cwd: Some(item.cwd.clone()),
                    all: false,
                },
                item.limit,
                item.max_seq,
            )
            .await?;
        text.push_str(&format!(
            "{}: up to {} entries scheduled (shared dedup)\n",
            item.session, item.limit
        ));
    }
    text.push_str("Unknown/partial HTTP can repeat; this does not rerun an Agent. Topic creation uncertainty is never retried under a new effect key automatically.");
    super::menu::sync_result(context, record, text, plan.next, plan.recent, plan.forum).await
}
