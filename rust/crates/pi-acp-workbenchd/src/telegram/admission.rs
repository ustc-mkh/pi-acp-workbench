//! Classification is frozen at durable admission, never guessed again at execution.
use super::{
    command::{parse_text, ControlCommand, RejectionReason, TelegramAction, TelegramCommand},
    types::{ChatId, IncomingContent, IncomingUpdate, UserId},
};
use crate::{
    domain::{error::DomainError, SessionSnapshot, WorkspacePath},
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
    snapshot: Option<&SessionSnapshot>,
    policy: &AdmissionPolicy,
    now: u64,
) -> Result<AdmissionResult, DomainError> {
    let state = store.snapshot().await?;
    let expected_binding = state.bindings.get(&update.topic).cloned();
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
            } => {
                query = Some(callback_query);
                let answer = (|| {
                    let binding = state
                        .callbacks
                        .get(&key)
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
                    let snapshot = snapshot
                        .filter(|snapshot| snapshot.id == binding.session)
                        .ok_or(RejectionReason::InvalidCallback)?;
                    let interaction = snapshot
                        .pending_interactions
                        .get(&binding.answer.interaction)
                        .ok_or(RejectionReason::InvalidCallback)?;
                    let answer = interaction
                        .validate_answer(binding.answer.clone(), now)
                        .map_err(|_| RejectionReason::InvalidAnswer)?;
                    callback = Some(key);
                    Ok(TelegramAction::Answer {
                        session: snapshot.id.clone(),
                        answer,
                    })
                })();
                Some(answer.unwrap_or_else(TelegramAction::Rejected))
            }
        }
    };
    if let Some(ref mut action) = action {
        match action {
            TelegramAction::Control(ControlCommand::NewSession {
                cwd, create_topic, ..
            }) => match authorize_workspace(cwd, &policy.cwd).await {
                Ok(canonical) => {
                    *cwd = canonical;
                    *create_topic = update.forum && update.topic.thread.is_none();
                }
                Err(_) => *action = TelegramAction::Rejected(RejectionReason::WorkspaceForbidden),
            },
            TelegramAction::Prompt { .. }
            | TelegramAction::Answer { .. }
            | TelegramAction::Control(
                ControlCommand::Status { .. }
                | ControlCommand::Cancel { .. }
                | ControlCommand::Remove { .. }
                | ControlCommand::SetModel { .. }
                | ControlCommand::SetMode { .. },
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
