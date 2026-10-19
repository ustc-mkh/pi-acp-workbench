//! Bounded parallel topic delivery. Shared JoinSet ownership survives a driver
//! abort; adapter supervision drains it before transport cleanup can finish.
use super::{
    api::BotApi,
    delivery::deliver_record,
    runtime::{now, AdapterError, Context},
    types::TopicKey,
};
use crate::{
    domain::{error::DomainError, DeliveryId, SessionId},
    persistence::outbox::DeliveryTarget,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use tokio::{
    sync::Mutex,
    task::JoinSet,
    time::{interval, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
const CAPACITY: usize = 8;
type Completion = (DeliveryId, Result<(), AdapterError>);
#[derive(Default)]
pub(crate) struct DeliveryJobs {
    tasks: Mutex<JoinSet<Completion>>,
}
impl DeliveryJobs {
    pub async fn drain(&self) -> Result<(), AdapterError> {
        join(&mut *self.tasks.lock().await).await
    }
}
async fn join(tasks: &mut JoinSet<Completion>) -> Result<(), AdapterError> {
    let mut result = Ok(());
    while let Some(completion) = tasks.join_next().await {
        let next = completion
            .map_err(|_| AdapterError::Task)
            .and_then(|(_, result)| result);
        if result.is_ok() {
            result = next;
        }
    }
    result
}
fn resolve(
    target: &DeliveryTarget,
    bindings: &BTreeMap<TopicKey, SessionId>,
) -> Result<Option<TopicKey>, DomainError> {
    Ok(match target {
        DeliveryTarget::Telegram { chat, thread, .. } => {
            Some(TopicKey::from_delivery(*chat, *thread)?)
        }
        DeliveryTarget::Session { session, .. } => bindings
            .iter()
            .find(|(_, bound)| *bound == session)
            .map(|(topic, _)| topic.clone()),
    })
}
pub(super) async fn dispatch(
    context: &Context<impl BotApi>,
    stop: &CancellationToken,
    once: bool,
) -> Result<(), AdapterError> {
    // Cancels HTTP children even if this driver future panics/is aborted. File
    // transactions deliberately do not select this token. The persistent task
    // owner, not Drop, performs physical joins.
    let http_stop = stop.child_token();
    let _cancel_http_on_drop = http_stop.clone().drop_guard();
    let mut tasks = context.delivery.tasks.lock().await;
    // Reentry after an interrupted observer may not replace still-owned jobs.
    join(&mut tasks).await?;
    let mut active: BTreeMap<DeliveryId, (DeliveryTarget, Option<TopicKey>)> = BTreeMap::new();
    let mut tick = interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut rescan = true;
    let result =
        'dispatch: loop {
            if stop.is_cancelled() || context.app.is_closing() {
                break Ok(());
            }
            if rescan && tasks.len() < CAPACITY {
                rescan = false;
                let outbox = context.app.delivery_store();
                // Binding and heads share one database read boundary. Deferred
                // heads reserve their topic even while their retry is not ready.
                let snapshot = match context
                    .app
                    .dispatch_snapshot(context.bot_id, outbox.capacity())
                    .await
                {
                    Ok(snapshot) => snapshot,
                    Err(DomainError::Backpressure) if !once => continue,
                    Err(error) => break Err(error.into()),
                };
                let bindings = snapshot.bindings;
                let records = snapshot.heads.into_iter().map(|row| {
                    crate::persistence::outbox::DeliveryRecord {
                        event: row.intent,
                        sequence: row.order.get(),
                        status: crate::persistence::outbox::DeliveryStatus::Pending,
                        attempt: row.attempt,
                        retry_at: row.retry_at.get(),
                        last_failure: row.last_failure,
                    }
                });
                let mut seen = BTreeSet::new();
                for (target, reserved) in active.values() {
                    if let Some(topic) = reserved {
                        seen.insert(topic.clone());
                    }
                    // If a binding changed, reserve its new destination too until
                    // the prior physical job joins. Never route into an active lane.
                    match resolve(target, &bindings) {
                        Ok(Some(topic)) => {
                            seen.insert(topic);
                        }
                        Ok(None) => {}
                        Err(error) => break 'dispatch Err(error.into()),
                    }
                }
                for record in records {
                    if active.contains_key(&record.event.id) {
                        continue;
                    }
                    let topic = match resolve(&record.event.target, &bindings) {
                        Ok(topic) => topic,
                        Err(error) => break 'dispatch Err(error.into()),
                    };
                    if let Some(topic) = &topic {
                        // Reserve even a deferred head so later records cannot
                        // overtake it on this destination.
                        if !seen.insert(topic.clone()) {
                            continue;
                        }
                        if record.retry_at > now() {
                            continue;
                        }
                    }
                    if tasks.len() >= CAPACITY {
                        continue;
                    }
                    active.insert(
                        record.event.id.clone(),
                        (record.event.target.clone(), topic.clone()),
                    );
                    let context = context.clone();
                    let stop = http_stop.clone();
                    tasks.spawn(async move {
                        let result = deliver_record(&context, &record, &topic, &stop).await;
                        (record.event.id, result)
                    });
                }
                if once && tasks.is_empty() {
                    break Ok(());
                }
            }
            tokio::select! {
                biased;
                _ = stop.cancelled() => break Ok(()),
                completion = tasks.join_next(), if !tasks.is_empty() => {
                    match completion {
                        Some(Ok((id, Ok(())))) => { active.remove(&id); rescan = true; },
                        Some(Ok((_, Err(error)))) => break Err(error),
                        _ => break Err(AdapterError::Task),
                    }
                }
                _ = tick.tick() => { rescan = true; }
            }
        };
    http_stop.cancel();
    let result = result.and(join(&mut tasks).await);
    if (stop.is_cancelled() || context.app.is_closing())
        && !matches!(
            result,
            Err(AdapterError::Domain(DomainError::Persistence(_)) | AdapterError::Task)
        )
    {
        Ok(())
    } else {
        result
    }
}
