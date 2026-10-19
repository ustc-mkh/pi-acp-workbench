use super::{
    admission::admit_update,
    api::BotApi,
    runtime::{now, pause, AdapterError, Context},
    types::IncomingContent,
};
use crate::{domain::error::DomainError, persistence::inbox::Admission};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
fn addressed(content: &mut IncomingContent, username: Option<&str>) {
    let IncomingContent::Text(text) = content else {
        return;
    };
    if !text.starts_with('/') {
        return;
    }
    let (name, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let Some((command, target)) = name.split_once('@') else {
        return;
    };
    if username.is_some_and(|username| username.eq_ignore_ascii_case(target)) {
        *text = if rest.is_empty() {
            command.into()
        } else {
            format!("{command} {rest}")
        };
    } else {
        *content = IncomingContent::Unsupported;
    }
}
#[cfg(test)]
pub(crate) async fn poll_once(context: &Context<impl BotApi>) -> Result<(), AdapterError> {
    poll_cancellable(context, &CancellationToken::new()).await
}
async fn poll_cancellable(
    context: &Context<impl BotApi>,
    stop: &CancellationToken,
) -> Result<(), AdapterError> {
    if stop.is_cancelled() || context.app.is_closing() {
        return Ok(());
    }
    let offset = context.store.offset().await?;
    // Only the read-only HTTP poll is cancellation-safe here. Once admission
    // starts, join its file transaction instead of dropping an atomic writer.
    let mut updates = tokio::select! { _ = stop.cancelled() => return Ok(()), result = context.api.get_updates(offset) => result? };
    updates.sort_by_key(|update| update.update_id);
    for update in updates {
        if stop.is_cancelled() || context.app.is_closing() {
            return Ok(());
        }
        let id = update.update_id;
        let query = update
            .callback_query
            .as_ref()
            .map(|callback| callback.id.clone())
            .filter(|query| {
                !query.is_empty() && query.len() <= 200 && !query.chars().any(char::is_control)
            });
        if let Some(mut incoming) = update.incoming() {
            addressed(&mut incoming.content, context.username.as_deref());
            let authorized = !incoming.from_bot
                && context
                    .config
                    .allowed_chat_ids
                    .contains(&incoming.topic.chat)
                && (context.config.allowed_user_ids.is_empty()
                    || context.config.allowed_user_ids.contains(&incoming.sender));
            let snapshot = if authorized {
                match context.store.binding(&incoming.topic).await? {
                    Some(session) => context.inspect(&session).await?,
                    None => None,
                }
            } else {
                None
            };
            admit_update(
                &context.store,
                incoming,
                snapshot.as_ref(),
                &context.policy(),
                now(),
            )
            .await?;
        } else {
            context
                .store
                .admit(Admission {
                    id,
                    sender: None,
                    command: None,
                    callback: None,
                    callback_query: None,
                    expected_binding: None,
                })
                .await?;
        }
        // Acknowledgement is presentation only, after durable admission. It can
        // be repeated without executing a user/domain command again.
        if let Some(query) = query {
            if let Ok(Err(error @ super::api::ApiError::Response { code: 401, .. })) =
                tokio::time::timeout(
                    Duration::from_secs(2),
                    context.api.answer_callback(&query, "Received"),
                )
                .await
            {
                return Err(error.into());
            }
        }
    }
    Ok(())
}
pub(crate) async fn run(
    context: Context<impl BotApi>,
    stop: CancellationToken,
) -> Result<(), AdapterError> {
    loop {
        let result = poll_cancellable(&context, &stop).await;
        if (stop.is_cancelled() || context.app.is_closing())
            && !matches!(
                result,
                Err(AdapterError::Domain(DomainError::Persistence(_)))
            )
        {
            return Ok(());
        }
        let delay = match result {
            Ok(()) => Duration::from_millis(100),
            Err(AdapterError::Domain(DomainError::Backpressure)) => Duration::from_millis(100),
            Err(AdapterError::Api(error)) if !error.fatal_poll() => {
                Duration::from_secs(error.retry_after())
            }
            Err(error) => return Err(error),
        };
        if !pause(&stop, delay).await {
            return Ok(());
        }
    }
}
