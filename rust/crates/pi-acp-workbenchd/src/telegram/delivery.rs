use super::{
    admission::authorize_workspace,
    api::{ApiError, BotApi, SendMedia, SendMessage},
    render,
    runtime::{now, AdapterError, Context},
    types::TopicKey,
};
use crate::{
    domain::error::DomainError,
    persistence::outbox::{DeliveryFailure, DeliveryRecord, DeliveryTarget},
};
use tokio_util::sync::CancellationToken;

enum Parts {
    Frozen(Box<super::turn_stream::TurnStream>),
    History(Box<super::turn_stream::HistoryStream>),
    Messages(std::vec::IntoIter<render::DeliveryPart>),
}
impl Parts {
    async fn next(
        &mut self,
        payloads: &crate::persistence::payload::PayloadStore,
    ) -> Result<Option<render::DeliveryPart>, DomainError> {
        match self {
            Self::Frozen(stream) => stream.next(payloads).await,
            Self::History(stream) => stream.next(payloads).await,
            Self::Messages(parts) => Ok(parts.next()),
        }
    }
}

enum Outgoing {
    Message(SendMessage),
    Media(SendMedia),
}
#[cfg(test)]
pub(crate) async fn deliver_once(context: &Context<impl BotApi>) -> Result<(), AdapterError> {
    super::delivery_scheduler::dispatch(context, &CancellationToken::new(), true).await
}
pub(super) async fn deliver_record(
    context: &Context<impl BotApi>,
    record: &DeliveryRecord,
    reserved: &Option<TopicKey>,
    stop: &CancellationToken,
) -> Result<(), AdapterError> {
    if stop.is_cancelled() || context.app.is_closing() {
        return Ok(());
    }
    let outbox = context.app.delivery_store();
    let history = matches!(
        &record.event.payload,
        crate::domain::transition::DeliveryPayload::HistoryEntry { .. }
    );
    let sent_to = {
        context
            .delivered
            .lock()
            .await
            .get(&record.event.id)
            .cloned()
    };
    if let Some(sent_to) = sent_to {
        outbox
            .ack_sent(&record.event.id, context.bot_id, &sent_to)
            .await?;
        context.delivered.lock().await.remove(&record.event.id);
        return Ok(());
    }
    let (topic, snapshot) = match &record.event.target {
        DeliveryTarget::Telegram {
            bot_id,
            chat,
            thread,
            cwd,
        } => {
            if context.bot_id != *bot_id {
                return Err(
                    DomainError::Persistence("delivery bot identity mismatch".into()).into(),
                );
            }
            if authorize_workspace(cwd, &context.config.workspace)
                .await
                .is_err()
            {
                if history {
                    outbox
                        .fail(
                            &record.event.id,
                            DeliveryFailure::InvalidTarget,
                            now().saturating_add(60),
                        )
                        .await?;
                } else {
                    outbox.ack(&record.event.id).await?;
                }
                return Ok(());
            }
            (Some(TopicKey::from_delivery(*chat, *thread)?), None)
        }
        DeliveryTarget::Session { session, cwd } => {
            let topic = context.store.topic(session).await?;
            // Binding changes must not move this job into another occupied lane.
            // Leave Pending and let the next scan reserve the new destination.
            if &topic != reserved {
                return Ok(());
            }
            let snapshot = if topic.is_some() {
                context.inspect(session).await?
            } else {
                None
            };
            if snapshot
                .as_ref()
                .is_some_and(|snapshot| &snapshot.cwd != cwd)
            {
                return Err(DomainError::Persistence(
                    "delivery workspace identity mismatch".into(),
                )
                .into());
            }
            // The immutable target retains its source scope after deletion.
            // It grants no arbitrary file reads and still must be authorized
            // against the current adapter workspace and topic binding.
            let allowed = authorize_workspace(cwd, &context.config.workspace)
                .await
                .is_ok();
            if !allowed {
                outbox.ack(&record.event.id).await?;
                return Ok(());
            }
            (topic, snapshot)
        }
    };
    if &topic != reserved {
        return Ok(());
    }
    let Some(topic) = topic.filter(|topic| context.config.allowed_chat_ids.contains(&topic.chat))
    else {
        if history {
            outbox
                .fail(
                    &record.event.id,
                    DeliveryFailure::InvalidTarget,
                    now().saturating_add(60),
                )
                .await?;
        } else {
            outbox.ack(&record.event.id).await?;
        }
        return Ok(());
    };
    if let crate::domain::transition::DeliveryPayload::Input {
        session,
        origin: Some(origin),
        ..
    } = &record.event.payload
    {
        if context
            .app
            .delivery_payloads()
            .input_origin(
                origin.clone(),
                context.bot_id,
                topic.clone(),
                session.clone(),
            )
            .await?
        {
            // The accepted user update is already visible in this exact topic.
            outbox
                .ack_sent(&record.event.id, context.bot_id, &topic)
                .await?;
            return Ok(());
        }
    }
    // Only automatic successful transcript/media delivery is optional. Typed
    // interactions, task errors/control notices and explicit query replies stay
    // visible. Muting acknowledges delivery intent, never deletes archives or
    // sends a command to the Agent.
    let automatic = matches!(&record.event.target, DeliveryTarget::Session { .. })
        && matches!(
            &record.event.payload,
            crate::domain::transition::DeliveryPayload::Turn { .. }
                | crate::domain::transition::DeliveryPayload::Input { .. }
                | crate::domain::transition::DeliveryPayload::Entry { .. }
                | crate::domain::transition::DeliveryPayload::Image { .. }
        );
    if automatic && !context.store.preferences(&topic).await?.notifications {
        outbox.ack(&record.event.id).await?;
        return Ok(());
    }
    let payloads = context.app.delivery_payloads();
    let mut parts = if let crate::domain::transition::DeliveryPayload::Input {
        session,
        entry,
        seq,
        ..
    } = &record.event.payload
    {
        Parts::History(Box::new(
            super::turn_stream::HistoryStream::new(
                &payloads,
                context.bot_id,
                topic.clone(),
                session,
                entry,
                *seq,
            )
            .await?
            .into_input(session),
        ))
    } else if let crate::domain::transition::DeliveryPayload::Turn { turn, session, .. } =
        &record.event.payload
    {
        Parts::Frozen(Box::new(
            super::turn_stream::TurnStream::new(
                record.event.id.clone(),
                turn.clone(),
                topic.clone(),
            )
            .with_history_scope(context.bot_id, session.clone()),
        ))
    } else if let crate::domain::transition::DeliveryPayload::HistoryEntry { session, entries } =
        &record.event.payload
    {
        Parts::History(Box::new(
            super::turn_stream::HistoryStream::new_group(
                &payloads,
                context.bot_id,
                topic.clone(),
                session,
                entries,
            )
            .await?,
        ))
    } else {
        match render::render(
            &record.event,
            &topic,
            snapshot.as_ref(),
            &context.app.delivery_payloads(),
            &context.store,
            now(),
        )
        .await
        {
            Ok(parts) => Parts::Messages(parts.into_iter()),
            Err(error @ DomainError::Persistence(_)) => return Err(error.into()),
            Err(_) => {
                outbox
                    .fail(
                        &record.event.id,
                        DeliveryFailure::PayloadUnavailable,
                        now().saturating_add(60),
                    )
                    .await?;
                return Ok(());
            }
        }
    };
    let mut failed = None;
    loop {
        if stop.is_cancelled() || context.app.is_closing() {
            return Ok(());
        }
        let part = match parts.next(&payloads).await {
            Ok(Some(part)) => part,
            Ok(None) => break,
            Err(error @ DomainError::Persistence(_)) => return Err(error.into()),
            Err(_) => {
                outbox
                    .fail(
                        &record.event.id,
                        DeliveryFailure::PayloadUnavailable,
                        now().saturating_add(60),
                    )
                    .await?;
                return Ok(());
            }
        };
        // Recheck between multipart sends: preferences may change while HTTP
        // was pending. A send already in flight cannot be recalled.
        let preferences = context.store.preferences(&topic).await?;
        if automatic && !preferences.notifications {
            outbox.ack(&record.event.id).await?;
            return Ok(());
        }
        // Read/verify local immutable bytes outside HTTP cancellation. Neither
        // image URIs nor caller-supplied filesystem paths authorize reads.
        let outgoing = match part {
            render::DeliveryPart::Message(mut message) => {
                message.disable_notification = history || preferences.silent;
                Outgoing::Message(message)
            }
            render::DeliveryPart::Image { topic, image } => Outgoing::Media(SendMedia {
                chat_id: topic.chat,
                message_thread_id: topic.thread,
                asset: context.app.delivery_payloads().image(&image).await?,
                disable_notification: history || preferences.silent,
            }),
        };
        // Cancellation can leave an uncertain remote send: retain Pending.
        // Callback/archive/ack/failure file transactions are never cancelled.
        let result = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            result = async {
                match &outgoing {
                    Outgoing::Message(message) => context.api.send_message(message).await,
                    Outgoing::Media(media) => context.api.send_media(media).await,
                }
            } => result,
        };
        if let Err(error) = result {
            failed = Some(error);
            break;
        }
    }
    if let Some(error) = failed {
        if matches!(error, ApiError::Response { code: 401, .. }) {
            return Err(error.into());
        }
        let failure = match error {
            ApiError::Response { code: 429, .. } => DeliveryFailure::RateLimited,
            ApiError::Response {
                code: 400 | 403, ..
            } => DeliveryFailure::InvalidTarget,
            _ => DeliveryFailure::Transport,
        };
        let exponential = 5_u64.saturating_mul(1 << record.attempt.min(6));
        let delay = error.retry_after().max(exponential);
        outbox
            .fail(&record.event.id, failure, now().saturating_add(delay))
            .await?;
    } else {
        context
            .delivered
            .lock()
            .await
            .insert(record.event.id.clone(), topic.clone());
        outbox
            .ack_sent(&record.event.id, context.bot_id, &topic)
            .await?;
        context.delivered.lock().await.remove(&record.event.id);
    }
    Ok(())
}
pub(crate) async fn run(
    context: Context<impl BotApi>,
    stop: CancellationToken,
) -> Result<(), AdapterError> {
    super::delivery_scheduler::dispatch(&context, &stop, false).await
}
