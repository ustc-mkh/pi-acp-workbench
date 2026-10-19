use super::types::TopicKey;
use crate::domain::{
    ids::{InteractionId, ModeId, ModelId},
    interaction::{Interaction, InteractionAnswer, InteractionResponse},
    query::SessionView,
    Harness, Prompt, SessionId, WorkspacePath,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TelegramCommand {
    pub topic: TopicKey,
    pub action: TelegramAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TelegramAction {
    Prompt {
        session: SessionId,
        prompt: Prompt,
    },
    Answer {
        session: SessionId,
        answer: InteractionAnswer,
    },
    Control(ControlCommand),
    Rejected(RejectionReason),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ControlCommand {
    Help,
    ListSessions,
    Status {
        session: SessionId,
    },
    Cancel {
        session: SessionId,
    },
    Remove {
        session: SessionId,
    },
    NewSession {
        harness: Harness,
        cwd: WorkspacePath,
        create_topic: bool,
    },
    Attach {
        session: SessionId,
    },
    SetModel {
        session: SessionId,
        model: ModelId,
    },
    SetMode {
        session: SessionId,
        mode: ModeId,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RejectionReason {
    UnknownCommand,
    NoSession,
    InvalidArguments,
    AmbiguousAnswer,
    InvalidAnswer,
    ExpiredInteraction,
    InvalidCallback,
    WrongTopic,
    AlreadyUsed,
    WorkspaceForbidden,
}
fn session(snapshot: Option<&SessionView>) -> Result<SessionId, RejectionReason> {
    snapshot
        .map(|snapshot| snapshot.id.clone())
        .ok_or(RejectionReason::NoSession)
}
fn answer(
    snapshot: &SessionView,
    interaction: &Interaction,
    text: String,
    now: u64,
) -> Result<TelegramAction, RejectionReason> {
    if interaction.expires_at.is_some_and(|expiry| now >= expiry) {
        return Err(RejectionReason::ExpiredInteraction);
    }
    let answer = interaction
        .validate_answer(
            InteractionAnswer {
                interaction: interaction.id.clone(),
                response: InteractionResponse::Text(text),
            },
            now,
        )
        .map_err(|_| RejectionReason::InvalidAnswer)?;
    Ok(TelegramAction::Answer {
        session: snapshot.id.clone(),
        answer,
    })
}
pub fn parse_text(
    snapshot: Option<&SessionView>,
    text: &str,
    cwd: &WorkspacePath,
    now: u64,
) -> Result<TelegramAction, RejectionReason> {
    let invalid = |_| RejectionReason::InvalidArguments;
    if let Some(command) = text
        .strip_prefix('/')
        .filter(|command| !command.starts_with('/'))
    {
        let (name, args) = command
            .split_once(char::is_whitespace)
            .map(|(name, args)| (name, args.trim()))
            .unwrap_or((command, ""));
        // Addressed bot commands are not guessed without a verified bot username.
        let control = match name {
            "help" | "start" if args.is_empty() => ControlCommand::Help,
            "sessions" if args.is_empty() => ControlCommand::ListSessions,
            "status" if args.is_empty() => ControlCommand::Status {
                session: session(snapshot)?,
            },
            "cancel" if args.is_empty() => ControlCommand::Cancel {
                session: session(snapshot)?,
            },
            "remove" if args.is_empty() => ControlCommand::Remove {
                session: session(snapshot)?,
            },
            "attach" => ControlCommand::Attach {
                session: SessionId::new(args).map_err(invalid)?,
            },
            "model" => ControlCommand::SetModel {
                session: session(snapshot)?,
                model: ModelId::new(args).map_err(invalid)?,
            },
            "mode" => ControlCommand::SetMode {
                session: session(snapshot)?,
                mode: ModeId::new(args).map_err(invalid)?,
            },
            "new" => {
                let mut parts = args.splitn(2, char::is_whitespace);
                let harness = match parts.next().unwrap_or_default() {
                    "" | "pi" => Harness::Pi,
                    "codex" => Harness::Codex,
                    "claude" => Harness::Claude,
                    _ => return Err(RejectionReason::InvalidArguments),
                };
                let cwd = match parts.next().map(str::trim).filter(|path| !path.is_empty()) {
                    Some(path) => WorkspacePath::new(path).map_err(invalid)?,
                    None => cwd.clone(),
                };
                ControlCommand::NewSession {
                    harness,
                    cwd,
                    create_topic: false,
                }
            }
            "answer" => {
                let (id, value) = args
                    .split_once(char::is_whitespace)
                    .ok_or(RejectionReason::InvalidArguments)?;
                let id = InteractionId::new(id).map_err(invalid)?;
                let snapshot = snapshot.ok_or(RejectionReason::NoSession)?;
                let interaction = snapshot
                    .pending_interactions
                    .get(&id)
                    .ok_or(RejectionReason::InvalidAnswer)?;
                if value.trim_start().starts_with('{') {
                    if interaction.expires_at.is_some_and(|expiry| now >= expiry) {
                        return Err(RejectionReason::ExpiredInteraction);
                    }
                    let response = serde_json::from_str::<InteractionResponse>(value.trim())
                        .map_err(|_| RejectionReason::InvalidAnswer)?;
                    let answer = interaction
                        .validate_answer(
                            InteractionAnswer {
                                interaction: id,
                                response,
                            },
                            now,
                        )
                        .map_err(|_| RejectionReason::InvalidAnswer)?;
                    return Ok(TelegramAction::Answer {
                        session: snapshot.id.clone(),
                        answer,
                    });
                }
                return answer(snapshot, interaction, value.trim().into(), now);
            }
            "prompt" => {
                return Ok(TelegramAction::Prompt {
                    session: session(snapshot)?,
                    prompt: Prompt::new(args).map_err(invalid)?,
                })
            }
            _ => return Err(RejectionReason::UnknownCommand),
        };
        return Ok(TelegramAction::Control(control));
    }
    let snapshot = snapshot.ok_or(RejectionReason::NoSession)?;
    if !text.starts_with("//") {
        match snapshot.pending_interactions.len() {
            0 => {}
            1 => {
                return answer(
                    snapshot,
                    snapshot
                        .pending_interactions
                        .values()
                        .next()
                        .expect("one interaction"),
                    text.into(),
                    now,
                )
            }
            _ => return Err(RejectionReason::AmbiguousAnswer),
        }
    }
    Ok(TelegramAction::Prompt {
        session: snapshot.id.clone(),
        prompt: Prompt::new(
            text.strip_prefix('/')
                .filter(|_| text.starts_with("//"))
                .unwrap_or(text),
        )
        .map_err(invalid)?,
    })
}
