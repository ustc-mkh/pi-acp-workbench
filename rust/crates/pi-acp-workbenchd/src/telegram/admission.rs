//! Classification is frozen at durable admission, never guessed again at execution.
use super::{
    command::{parse_text, ControlCommand, RejectionReason, TelegramAction, TelegramCommand},
    types::{CallbackAction, ChatId, IncomingContent, IncomingUpdate, UserId},
};
use crate::{
    domain::{error::DomainError, query::SessionView, WorkspacePath},
    persistence::inbox::{Admission, AdmissionResult, TelegramStore},
};
use std::collections::BTreeSet;
pub struct AdmissionPolicy {
    pub chats: BTreeSet<ChatId>,
    pub users: BTreeSet<UserId>,
    pub cwd: WorkspacePath,
}
pub async fn admit_update(
    store: &TelegramStore,
    update: IncomingUpdate,
    snapshot: Option<&SessionView>,
    policy: &AdmissionPolicy,
    now: u64,
) -> Result<AdmissionResult, DomainError> {
    let expected_binding = store.binding(&update.topic).await?;
    let snapshot = snapshot.filter(|snapshot| expected_binding.as_ref() == Some(&snapshot.id));
    let mut callback = None;
    let mut query = None;
    let mut action = if update.from_bot
        || !policy.chats.contains(&update.topic.chat)
        || (!policy.users.is_empty() && !policy.users.contains(&update.sender))
    {
        None
    } else {
        match update.content {
            IncomingContent::Unsupported => None,
            IncomingContent::Text(text) => Some(
                parse_text(snapshot, &text, &policy.cwd, now)
                    .unwrap_or_else(TelegramAction::Rejected),
            ),
            IncomingContent::Callback {
                key,
                query: callback_query,
                message,
            } => {
                query = Some(callback_query);
                let callback_binding = store.callback(&key).await?;
                let answer = (|| {
                    let binding = callback_binding
                        .as_ref()
                        .ok_or(RejectionReason::InvalidCallback)?;
                    if binding.topic != update.topic {
                        return Err(RejectionReason::WrongTopic);
                    }
                    if binding.used_by.is_some() {
                        return Err(RejectionReason::AlreadyUsed);
                    }
                    if now >= binding.expires_at {
                        return Err(RejectionReason::ExpiredInteraction);
                    }
                    let action = match &binding.action {
                        CallbackAction::Answer { session, answer } => {
                            let snapshot = snapshot
                                .filter(|snapshot| &snapshot.id == session)
                                .ok_or(RejectionReason::InvalidCallback)?;
                            let interaction = snapshot
                                .pending_interactions
                                .get(&answer.interaction)
                                .ok_or(RejectionReason::InvalidCallback)?;
                            let answer = interaction
                                .validate_answer(answer.clone(), now)
                                .map_err(|_| RejectionReason::InvalidAnswer)?;
                            TelegramAction::Answer {
                                session: snapshot.id.clone(),
                                answer,
                                card: message,
                            }
                        }
                        CallbackAction::Control {
                            command,
                            expected_binding: expected,
                        } => {
                            if expected != &expected_binding {
                                return Err(RejectionReason::InvalidCallback);
                            }
                            TelegramAction::Control(command.clone())
                        }
                    };
                    callback = Some(key);
                    Ok(action)
                })();
                Some(answer.unwrap_or_else(TelegramAction::Rejected))
            }
        }
    };
    if let Some(ref mut action) = action {
        match action {
            TelegramAction::Control(ControlCommand::Sync { forum, .. }) => {
                if callback.is_some() && *forum != update.forum {
                    *action = TelegramAction::Rejected(RejectionReason::InvalidCallback);
                } else {
                    *forum = update.forum;
                }
            }
            TelegramAction::Control(ControlCommand::Menu { create_topic, .. }) => {
                let forum_general = update.forum;
                if callback.is_some() && *create_topic != forum_general {
                    *action = TelegramAction::Rejected(RejectionReason::InvalidCallback);
                } else {
                    *create_topic = forum_general;
                }
            }
            TelegramAction::Control(ControlCommand::NewSession {
                cwd, create_topic, ..
            }) => match authorize_workspace(cwd, &policy.cwd).await {
                Ok(canonical) => {
                    let forum_general = update.forum;
                    if callback.is_some() && (*cwd != canonical || *create_topic != forum_general) {
                        *action = TelegramAction::Rejected(RejectionReason::InvalidCallback);
                    } else {
                        *cwd = canonical;
                        *create_topic = forum_general;
                    }
                }
                Err(_) => *action = TelegramAction::Rejected(RejectionReason::WorkspaceForbidden),
            },
            TelegramAction::Prompt { .. }
            | TelegramAction::Answer { .. }
            | TelegramAction::Control(
                ControlCommand::Status { .. }
                | ControlCommand::Cancel { .. }
                | ControlCommand::Interrupt { .. }
                | ControlCommand::Discover { .. }
                | ControlCommand::Remove { .. }
                | ControlCommand::SetModel { .. }
                | ControlCommand::SetMode { .. }
                | ControlCommand::SetOption { .. },
            ) => {
                if let Some(snapshot) = snapshot {
                    if authorize_workspace(&snapshot.cwd, &policy.cwd)
                        .await
                        .is_err()
                    {
                        callback = None;
                        *action = TelegramAction::Rejected(RejectionReason::WorkspaceForbidden);
                    }
                }
            }
            _ => {}
        }
    }
    // A failed revalidation is a durable rejection, not consumption of a
    // different command under the callback key (which SQL correctly forbids).
    if matches!(action, Some(TelegramAction::Rejected(_))) {
        callback = None;
    }
    store
        .admit(Admission {
            id: update.id,
            sender: Some(update.sender),
            command: action.map(|action| TelegramCommand {
                topic: update.topic,
                action,
            }),
            callback,
            callback_query: query,
            expected_binding,
        })
        .await
}
pub async fn authorize_workspace(
    cwd: &WorkspacePath,
    root: &WorkspacePath,
) -> Result<WorkspacePath, DomainError> {
    let root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| DomainError::InvalidAnswer("workspace unavailable".into()))?;
    let cwd = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| DomainError::InvalidAnswer("workspace unavailable".into()))?;
    if !cwd.is_dir() || !cwd.starts_with(root) {
        return Err(DomainError::InvalidAnswer(
            "workspace outside Telegram root".into(),
        ));
    }
    Ok(WorkspacePath::new(cwd.to_str().ok_or_else(|| {
        DomainError::InvalidAnswer("non-UTF8 workspace".into())
    })?)?)
}
