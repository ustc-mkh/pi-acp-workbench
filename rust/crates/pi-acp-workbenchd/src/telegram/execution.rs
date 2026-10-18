use super::{
    admission::authorize_workspace,
    api::BotApi,
    command::{ControlCommand, RejectionReason, TelegramAction},
    render,
    runtime::Context,
    state::{InboxOutcome, InboxRecord},
    types::TopicKey,
};
use crate::{
    domain::{
        error::DomainError, DeliveryId, DomainCommand, DomainEvent, NoticeId, OperationId,
        SessionId,
    },
    persistence::{
        outbox::{DeliveryEvent, DeliveryPayload},
        payload::NoticeContent,
    },
};
#[path = "execution_scheduler.rs"]
mod scheduler;
pub(crate) use scheduler::run;
const HELP: &str = "/new [pi|codex|claude] [绝对路径] — 新会话（论坛 General 中创建话题）\n/attach ID · /sessions · /status · /cancel · /remove\n/model ID · /mode ID\n/answer INTERACTION_ID TEXT_OR_TYPED_JSON\n/prompt TEXT — 明确发送 prompt，不猜作回答\n多字段回答示例：/answer ID {\"Form\":{\"fields\":{\"name\":{\"Text\":\"value\"}}}}";
fn rejected(reason: &RejectionReason) -> &'static str {
    match reason {
        RejectionReason::UnknownCommand => "未知命令。使用 /help。",
        RejectionReason::NoSession => "此话题没有会话。使用 /new 或 /attach ID。",
        RejectionReason::AmbiguousAnswer => "存在多个待回答交互。请用 /answer ID 指定。",
        RejectionReason::ExpiredInteraction => "交互已过期；未执行回答。",
        RejectionReason::WrongTopic => "按钮不属于此话题；未执行。",
        RejectionReason::AlreadyUsed => "按钮已使用；不会重复执行。",
        RejectionReason::WorkspaceForbidden => "工作区不在此 Bot 的授权范围内。",
        RejectionReason::InvalidCallback => "按钮无效或交互已结束；未执行。",
        _ => "参数或回答无效；未执行。使用 /help。",
    }
}
fn failure(error: &DomainError) -> &'static str {
    match error {
        DomainError::Busy => "会话忙；未替换当前 turn。请等待完成或 /cancel。",
        DomainError::OperationInterrupted => {
            "操作结果不确定，已禁止自动重复。请用 /status 检查后人工处理。"
        }
        DomainError::OperationConflict => "操作 ID 冲突；未重复执行。",
        DomainError::OperationExpired => "操作收据已过期；未重复执行。",
        DomainError::InteractionExpired | DomainError::InteractionNotFound => {
            "交互已结束或过期；回答不会转为新 prompt。"
        }
        DomainError::NotFound(_) => "会话不存在。使用 /new 或 /sessions。",
        _ => "操作失败；未自动重复。请检查宿主状态。",
    }
}
async fn domain(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    command: DomainCommand,
    scope: Option<&SessionId>,
) -> Result<Vec<DomainEvent>, DomainError> {
    if let Some(result) = context
        .app
        .operation_result(&record.operation, &command)
        .await?
    {
        return result;
    }
    if let Some(session) = scope {
        match context.inspect(session).await? {
            Some(snapshot) => {
                authorize_workspace(&snapshot.cwd, &context.config.workspace).await?;
            }
            None if matches!(command, DomainCommand::RemoveSession(_)) => {}
            None => return Err(DomainError::NotFound(session.clone())),
        }
        if matches!(
            command,
            DomainCommand::Prompt { .. }
                | DomainCommand::AnswerInteraction { .. }
                | DomainCommand::Cancel { .. }
                | DomainCommand::SetModel { .. }
                | DomainCommand::SetMode { .. }
        ) {
            // Inspect is deliberately cold/read-only. Execution must explicitly
            // establish an actor owner; admission and /status must not do this.
            context
                .app
                .command(DomainCommand::LoadSession(session.clone()))
                .await?;
        }
    }
    context
        .app
        .command_durable(record.operation.clone(), command)
        .await
}
pub(crate) async fn dispatch(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
) -> Result<Option<(TopicKey, String)>, DomainError> {
    let topic = &record.command.topic;
    let reply = match &record.command.action {
        TelegramAction::Rejected(reason) => rejected(reason).into(),
        TelegramAction::Prompt { session, prompt } => {
            domain(
                context,
                record,
                DomainCommand::Prompt {
                    session: session.clone(),
                    prompt: prompt.clone(),
                },
                Some(session),
            )
            .await?;
            return Ok(None);
        }
        TelegramAction::Answer { session, answer } => {
            domain(
                context,
                record,
                DomainCommand::AnswerInteraction {
                    session: session.clone(),
                    answer: answer.clone(),
                },
                Some(session),
            )
            .await?;
            return Ok(None);
        }
        TelegramAction::Control(control) => match control {
            ControlCommand::Help => HELP.into(),
            ControlCommand::NewSession {
                harness,
                cwd,
                create_topic,
            } => {
                authorize_workspace(cwd, &context.config.workspace).await?;
                let command = DomainCommand::CreateSession {
                    harness: harness.clone(),
                    cwd: cwd.clone(),
                };
                let existing = context
                    .app
                    .operation_result(&record.operation, &command)
                    .await?;
                let mut destination = topic.clone();
                if *create_topic {
                    let operation = OperationId::new(format!("topic-{}", record.id.get()))?;
                    let folder = cwd
                        .as_ref()
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("workspace");
                    let name: String = format!("{harness:?}: {folder}").chars().take(100).collect();
                    destination.thread = Some(if existing.is_some() {
                        context
                            .effects
                            .completed(&operation, topic.chat, &name)
                            .await?
                    } else {
                        context
                            .effects
                            .create_topic(operation, &context.api, topic.chat, name)
                            .await?
                    });
                }
                let events = match existing {
                    Some(result) => result?,
                    None => {
                        context
                            .app
                            .command_durable(record.operation.clone(), command)
                            .await?
                    }
                };
                let snapshot = events
                    .into_iter()
                    .find_map(|event| {
                        if let DomainEvent::SessionCreated(snapshot) = event {
                            Some(snapshot)
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| {
                        DomainError::Persistence("create receipt missing snapshot".into())
                    })?;
                context
                    .store
                    .bind(destination.clone(), snapshot.id.clone())
                    .await?;
                return Ok(Some((
                    destination,
                    format!(
                        "Session {}\n{:?}\n{}",
                        snapshot.id,
                        snapshot.harness,
                        snapshot.cwd.as_str()
                    ),
                )));
            }
            ControlCommand::Attach { session } => {
                let events = domain(
                    context,
                    record,
                    DomainCommand::LoadSession(session.clone()),
                    Some(session),
                )
                .await?;
                let snapshot = events
                    .into_iter()
                    .find_map(|event| {
                        if let DomainEvent::SessionLoaded(snapshot) = event {
                            Some(snapshot)
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| {
                        DomainError::Persistence("load receipt missing snapshot".into())
                    })?;
                authorize_workspace(&snapshot.cwd, &context.config.workspace).await?;
                context.store.bind(topic.clone(), session.clone()).await?;
                format!("Attached session {session}")
            }
            ControlCommand::Status { session } => {
                let events = domain(
                    context,
                    record,
                    DomainCommand::Inspect(session.clone()),
                    Some(session),
                )
                .await?;
                let snapshot = events
                    .into_iter()
                    .find_map(|event| {
                        if let DomainEvent::SessionLoaded(snapshot) = event {
                            Some(snapshot)
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| {
                        DomainError::Persistence("status receipt missing snapshot".into())
                    })?;
                render::status(&snapshot)
            }
            ControlCommand::ListSessions => {
                let events = domain(context, record, DomainCommand::ListSessions, None).await?;
                let mut text = String::new();
                for event in events {
                    if let DomainEvent::SessionsListed(sessions) = event {
                        for session in sessions {
                            if authorize_workspace(&session.cwd, &context.config.workspace)
                                .await
                                .is_ok()
                            {
                                text.push_str(&format!(
                                    "{} · {:?} · {}\n",
                                    session.id,
                                    session.harness,
                                    session.cwd.as_str()
                                ));
                            }
                        }
                    }
                }
                if text.is_empty() {
                    "暂无授权会话。使用 /new。".into()
                } else {
                    text
                }
            }
            ControlCommand::Cancel { session } => {
                domain(
                    context,
                    record,
                    DomainCommand::Cancel {
                        session: session.clone(),
                    },
                    Some(session),
                )
                .await?;
                "Cancelled.".into()
            }
            ControlCommand::Remove { session } => {
                domain(
                    context,
                    record,
                    DomainCommand::RemoveSession(session.clone()),
                    Some(session),
                )
                .await?;
                context.store.unbind(topic, session).await?;
                "Removed session.".into()
            }
            ControlCommand::SetModel { session, model } => {
                domain(
                    context,
                    record,
                    DomainCommand::SetModel {
                        session: session.clone(),
                        model: model.clone(),
                    },
                    Some(session),
                )
                .await?;
                format!("Model: {model}")
            }
            ControlCommand::SetMode { session, mode } => {
                domain(
                    context,
                    record,
                    DomainCommand::SetMode {
                        session: session.clone(),
                        mode: mode.clone(),
                    },
                    Some(session),
                )
                .await?;
                format!("Mode: {mode}")
            }
        },
    };
    Ok(Some((topic.clone(), reply)))
}
async fn queue_notice(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    topic: TopicKey,
    text: String,
) -> Result<(), DomainError> {
    let notice = NoticeId::new(format!("reply-{}", record.id.get()))?;
    let notice_content = NoticeContent { id: notice, text };
    let content = crate::persistence::payload::PayloadStore::notice_ref(&notice_content)?;
    context
        .app
        .delivery_payloads()
        .put_notice(&notice_content)
        .await?;
    let bot_id = context
        .store
        .snapshot()
        .await?
        .bot
        .ok_or_else(|| DomainError::Persistence("missing Telegram bot identity".into()))?
        .get();
    context
        .app
        .delivery_store()
        .enqueue(DeliveryEvent {
            id: DeliveryId::new(format!("reply-{}", record.id.get()))?,
            revision: crate::domain::query::SafeInteger::new(record.id.get())
                .map_err(|error| DomainError::Persistence(error.to_string()))?,
            target: topic.delivery_target(bot_id, context.config.workspace.clone()),
            payload: DeliveryPayload::Notice { content },
        })
        .await
}
pub(crate) async fn execute_record(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
) -> Result<(), DomainError> {
    if context.app.is_closing() {
        return Err(DomainError::Backpressure);
    }
    if !context.authorized(record) {
        return context
            .store
            .complete(record.id, InboxOutcome::Rejected)
            .await;
    }
    let dispatched = dispatch(context, record).await;
    if context.app.is_closing() && !matches!(dispatched, Err(DomainError::Persistence(_))) {
        // Keep the durable classification pending. Accepted domain operations
        // settle in the host; restart can recover their immutable receipts.
        return Err(DomainError::Backpressure);
    }
    let (reply, outcome) = match dispatched {
        Ok(reply) => (
            reply,
            if matches!(record.command.action, TelegramAction::Rejected(_)) {
                InboxOutcome::Rejected
            } else {
                InboxOutcome::Applied
            },
        ),
        Err(error @ DomainError::Persistence(_)) => return Err(error),
        Err(error) => (
            Some((record.command.topic.clone(), failure(&error).into())),
            if matches!(error, DomainError::OperationInterrupted) {
                InboxOutcome::Interrupted
            } else {
                InboxOutcome::Failed
            },
        ),
    };
    if let Some((topic, text)) = reply {
        queue_notice(context, record, topic, text).await?;
    }
    context.store.complete(record.id, outcome).await
}
