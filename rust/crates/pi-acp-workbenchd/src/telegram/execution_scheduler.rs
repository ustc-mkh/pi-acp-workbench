//! Inbox execution owns at most 8 ordinary + 4 control + 4 query tasks.
//! Mutation FIFO is per topic; query/rejection notices read committed state and
//! do not wait behind a blocked provider. No detached record/file-write futures.
use super::execute_record;
use crate::{
    domain::error::DomainError,
    telegram::{
        api::BotApi,
        command::{ControlCommand, TelegramAction},
        runtime::{AdapterError, Context},
        state::InboxRecord,
        types::{TopicKey, UpdateId},
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use tokio::{
    task::JoinSet,
    time::{interval, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
const CAPACITY: [usize; 3] = [8, 4, 4];
fn pool(record: &InboxRecord) -> usize {
    match record.command.action {
        TelegramAction::Rejected(_)
        | TelegramAction::Control(
            ControlCommand::Help
            | ControlCommand::Menu { .. }
            | ControlCommand::ListSessions
            | ControlCommand::Queue
            | ControlCommand::Status { .. }
            | ControlCommand::Notifications { enabled: None }
            | ControlCommand::Silent { enabled: None },
        ) => 2,
        TelegramAction::Answer { .. }
        | TelegramAction::Control(
            ControlCommand::Cancel { .. }
            | ControlCommand::Interrupt { .. }
            | ControlCommand::History { .. }
            | ControlCommand::Sync { .. }
            | ControlCommand::Remove { .. }
            | ControlCommand::Notifications { enabled: Some(_) }
            | ControlCommand::Silent { enabled: Some(_) },
        ) => 1,
        _ => 0,
    }
}
pub(crate) async fn run(
    context: Context<impl BotApi>,
    stop: CancellationToken,
) -> Result<(), AdapterError> {
    let mut tasks = JoinSet::new();
    let mut active: BTreeMap<UpdateId, (TopicKey, usize)> = BTreeMap::new();
    let mut tick = interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let result = 'scheduler: loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break Ok(()),
            result = tasks.join_next(), if !tasks.is_empty() => {
                match result {
                    Some(Ok((id, result))) => {
                        active.remove(&id);
                        match result { Ok(()) | Err(DomainError::Backpressure) => {}, Err(error) => break Err(AdapterError::Domain(error)) }
                    }
                    _ => break Err(AdapterError::Task),
                }
            }
            _ = tick.tick() => {
                // Inbox admission already bounds the pending records. Looking
                // only at the first eight would hide controls behind busy lanes.
                let records = match context.store.pending(context.config.inbox_capacity).await {
                    Ok(records) => records,
                    Err(DomainError::Backpressure) => continue,
                    Err(error) => break Err(AdapterError::Domain(error)),
                };
                let mut used = [0; 3];
                let mut blocked = BTreeSet::new();
                for (topic, class) in active.values() { used[*class] += 1; if *class != 2 { blocked.insert(topic.clone()); } }
                let mut waiting = BTreeSet::new();
                for record in records {
                    if active.contains_key(&record.id) { continue; }
                    let class = if context.authorized(&record) { pool(&record) } else { 2 };
                    // Reserve the first unscheduled mutation too: a later
                    // control must not jump an earlier same-topic config/new.
                    let barrier = matches!(&record.command.action, TelegramAction::Answer { .. } | TelegramAction::Control(ControlCommand::Cancel { .. } | ControlCommand::Interrupt { .. }));
                    let queued_topic = waiting.contains(&record.command.topic);
                    if class != 2 && !blocked.insert(record.command.topic.clone()) {
                        if !(barrier && queued_topic) {
                            // Only waiting prompts may be crossed. A config/new/history
                            // between them and a control retains the causal boundary.
                            if !matches!(&record.command.action, TelegramAction::Prompt { .. }) {
                                waiting.remove(&record.command.topic);
                            }
                            continue;
                        }
                        waiting.remove(&record.command.topic);
                    }
                    if let TelegramAction::Prompt { session, .. } = &record.command.action {
                        if context.authorized(&record) {
                            if let Err(error) = context.app.command(crate::domain::DomainCommand::LoadSession(session.clone())).await {
                                if matches!(error, DomainError::Persistence(_)) { break 'scheduler Err(AdapterError::Domain(error)); }
                            }
                        }
                        match context.inspect(session).await {
                            Ok(Some(view)) if context.authorized(&record) && (view.active_turn.is_some() || view.configuration_intent.is_some()) => { waiting.insert(record.command.topic.clone()); continue; }
                            Err(error) => break 'scheduler Err(AdapterError::Domain(error)),
                            _ => {}
                        }
                    }
                    if used[class] >= CAPACITY[class] { continue; }
                    used[class] += 1;
                    active.insert(record.id, (record.command.topic.clone(), class));
                    let context = context.clone();
                    tasks.spawn(async move { (record.id, execute_record(&context, &record).await) });
                }
            }
        }
    };
    stop.cancel();
    context.app.close_admission();
    let mut cleanup = Ok(());
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok((_, Ok(()) | Err(DomainError::Backpressure))) => {}
            Ok((_, Err(error))) => cleanup = Err(AdapterError::Domain(error)),
            Err(_) => cleanup = Err(AdapterError::Task),
        }
    }
    result.and(cleanup)
}
