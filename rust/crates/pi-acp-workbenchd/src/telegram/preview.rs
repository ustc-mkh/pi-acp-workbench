//! Disposable bounded text tails. HTTP runs in the existing sender JoinSet,
//! only after reliable heads and within its eight-lane/topic reservations.
use super::{
    admission::authorize_workspace,
    api::{BotApi, SendMessage},
    runtime::{AdapterError, Context},
    types::{MessageId, TopicKey},
};
use crate::domain::{query::TextBody, transcript::EntryRole, SessionId, TurnId, WorkspacePath};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub(super) struct Candidate {
    pub session: SessionId,
    pub turn: TurnId,
    pub cwd: WorkspacePath,
    text: String,
    message: Option<MessageId>,
}
struct Tail {
    value: Candidate,
    due: Instant,
    dirty: bool,
    disabled: bool,
}
#[derive(Default)]
pub(crate) struct State {
    tails: BTreeMap<SessionId, Tail>,
}
impl State {
    pub(super) fn due(&mut self) -> Vec<Candidate> {
        self.tails
            .values_mut()
            .filter_map(|tail| {
                if tail.disabled || !tail.dirty || tail.due > Instant::now() {
                    return None;
                }
                tail.dirty = false;
                tail.due = Instant::now() + Duration::from_secs(3);
                Some(tail.value.clone())
            })
            .take(2)
            .collect()
    }
}
pub(super) async fn observe(
    context: Context<impl BotApi>,
    stop: CancellationToken,
) -> Result<(), AdapterError> {
    let mut batches = context.app.subscribe();
    loop {
        let batch =
            tokio::select! { _ = stop.cancelled() => break, batch = batches.recv() => batch };
        let batch = match batch {
            Ok(batch) => batch,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                context.preview.lock().await.tails.clear();
                continue;
            }
            Err(_) => break,
        };
        let mut state = context.preview.lock().await;
        let Some(view) = batch.view else {
            if batch.removed {
                state.tails.remove(&batch.session);
            }
            continue;
        };
        let Some(turn) = view.active_turn else {
            state.tails.remove(&batch.session);
            continue;
        };
        for entry in batch.entries {
            if entry.role != EntryRole::Agent || entry.turn != turn {
                continue;
            }
            let TextBody::Inline { text } = entry.text else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            if !state.tails.contains_key(&batch.session) && state.tails.len() >= 8 {
                continue;
            }
            let tail = state
                .tails
                .entry(batch.session.clone())
                .or_insert_with(|| Tail {
                    value: Candidate {
                        session: batch.session.clone(),
                        turn: turn.clone(),
                        cwd: view.cwd.clone(),
                        text: String::new(),
                        message: None,
                    },
                    due: Instant::now() + Duration::from_secs(3),
                    dirty: false,
                    disabled: false,
                });
            if tail.value.turn != turn {
                *tail = Tail {
                    value: Candidate {
                        session: batch.session.clone(),
                        turn: turn.clone(),
                        cwd: view.cwd.clone(),
                        text: String::new(),
                        message: None,
                    },
                    due: Instant::now() + Duration::from_secs(3),
                    dirty: false,
                    disabled: false,
                };
            }
            tail.value.text.push_str(&text);
            tail.value.text = bounded_tail(&tail.value.text);
            tail.dirty = true;
        }
    }
    context.preview.lock().await.tails.clear();
    Ok(())
}
fn bounded_tail(text: &str) -> String {
    let mut units = 0;
    let mut start = text.len();
    for (index, ch) in text.char_indices().rev() {
        units += ch.len_utf16();
        if units > 3000 {
            break;
        }
        start = index;
    }
    text[start..].to_owned()
}

pub(super) async fn send(
    context: &Context<impl BotApi>,
    candidate: Candidate,
    topic: TopicKey,
    stop: &CancellationToken,
) {
    if !context.config.allowed_chat_ids.contains(&topic.chat)
        || context
            .store
            .topic(&candidate.session)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&topic)
    {
        return;
    }
    if !matches!(context.inspect(&candidate.session).await, Ok(Some(view)) if view.active_turn.as_ref() == Some(&candidate.turn))
    {
        return;
    }
    if authorize_workspace(&candidate.cwd, &context.config.workspace)
        .await
        .is_err()
        || !context
            .store
            .preferences(&topic)
            .await
            .is_ok_and(|prefs| prefs.notifications)
    {
        return;
    }
    let message = SendMessage {
        chat_id: topic.chat,
        message_thread_id: topic.thread,
        text: format!(
            "Running · preview only, may be incomplete\n{}",
            candidate.text
        ),
        disable_notification: true,
        reply_markup: None,
    };
    let sent = tokio::select! { _ = stop.cancelled() => return, result = tokio::time::timeout(Duration::from_secs(1), async {
        if let Some(id) = candidate.message { context.api.edit_message(id, &message).await } else { context.api.send_message(&message).await }
    }) => result };
    if let Some(tail) = context
        .preview
        .lock()
        .await
        .tails
        .get_mut(&candidate.session)
        .filter(|tail| tail.value.turn == candidate.turn)
    {
        match sent {
            Ok(Ok(message)) => tail.value.message = Some(message.message_id),
            _ => tail.disabled = true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_tail_is_utf16_bounded_and_preserves_suffix() {
        let text = "中😀```rust\n".repeat(1000);
        let tail = bounded_tail(&text);
        assert!(tail.encode_utf16().count() <= 3000);
        assert!(text.ends_with(&tail));
        assert!(tail.encode_utf16().count() >= 2999);
        assert_eq!(bounded_tail(""), "");
        assert_eq!(bounded_tail("中😀"), "中😀");
    }

    #[test]
    fn due_is_bounded_coalesced_and_throttled_and_disables_failed_turn() {
        let mut state = State::default();
        for index in 0..8 {
            let session = SessionId::new(format!("preview-{index}")).unwrap();
            state.tails.insert(
                session.clone(),
                Tail {
                    value: Candidate {
                        session,
                        turn: TurnId::generate(),
                        cwd: WorkspacePath::new("/tmp").unwrap(),
                        text: "latest coalesced text".into(),
                        message: None,
                    },
                    due: Instant::now(),
                    dirty: true,
                    disabled: index == 0,
                },
            );
        }
        assert_eq!(state.due().len(), 2);
        assert_eq!(state.due().len(), 2);
        assert_eq!(state.due().len(), 2);
        assert_eq!(state.due().len(), 1);
        assert!(state.due().is_empty());
        for tail in state.tails.values_mut() {
            tail.dirty = true;
        }
        // A failed turn remains disabled; successful tails cannot edit again
        // before the three-second deadline, even after more deltas arrive.
        assert!(state.due().is_empty());
    }
}
