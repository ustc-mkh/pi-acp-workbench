use super::{
    admission::authorize_workspace,
    api::BotApi,
    command::{ControlCommand, RejectionReason, TelegramAction},
    render,
    runtime::Context,
    state::{InboxOutcome, InboxRecord},
    types::{TopicKey, TopicPreference},
};
use crate::{
    domain::{
        error::DomainError, query::CommandReceipt, DeliveryId, DomainCommand, NoticeId,
        OperationId, SessionId,
    },
    persistence::{
        outbox::{DeliveryEvent, DeliveryPayload},
        payload::NoticeContent,
    },
};
#[path = "execution_scheduler.rs"]
mod scheduler;
pub(crate) use scheduler::run;
const HELP: &str = "/menu [directories|sessions|models|modes] · /new [pi|codex|claude] [绝对路径] — 新会话（论坛 General 中创建话题）\n/open ID（/attach ID） · /sessions · /status · /history [all] · /sync · /queue · /stop（/cancel） · /interrupt TEXT · /remove\n/discover — 启动受控模型发现（不发送业务任务） · /model ID · /mode ID\n/notifications [on|off] · /silent [on|off] — 此话题推送/静音设置\n/answer INTERACTION_ID TEXT_OR_TYPED_JSON\n/prompt TEXT — 明确发送 prompt，不猜作回答\n多字段回答示例：/answer ID {\"Form\":{\"fields\":{\"name\":{\"Text\":\"value\"}}}}";
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
        DomainError::InvalidAnswer(reason)
            if reason == "session already bound to another Telegram topic" =>
        {
            "会话已绑定其他话题；请在原话题继续，不会自动移动绑定。"
        }
        _ => "操作失败；未自动重复。请检查宿主状态。",
    }
}
async fn domain(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    command: DomainCommand,
    scope: Option<&SessionId>,
) -> Result<CommandReceipt, DomainError> {
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
                | DomainCommand::SetOption { .. }
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
async fn submit_prompt(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
    session: &SessionId,
    prompt: &crate::domain::Prompt,
    initial: OperationId,
) -> Result<(), DomainError> {
    let command = DomainCommand::Prompt {
        session: session.clone(),
        prompt: prompt.clone(),
    };
    let previous = context.store.prompt_attempt(record.id, None).await?;
    let mut operation = previous.clone().unwrap_or(initial);
    if matches!(
        context.app.operation_result(&operation, &command).await?,
        Some(Err(DomainError::Busy))
    ) {
        let view = context
            .inspect(session)
            .await?
            .ok_or_else(|| DomainError::NotFound(session.clone()))?;
        if view.active_turn.is_some() || view.configuration_intent.is_some() {
            return Err(DomainError::Busy);
        }
        operation = OperationId::new(format!(
            "queue-{}-v{}",
            record.id.get(),
            view.revision.get()
        ))?;
    }
    if previous.as_ref() != Some(&operation) {
        context
            .store
            .prompt_attempt(record.id, Some((previous, operation.clone())))
            .await?;
    }
    let mut attempt = record.clone();
    attempt.operation = operation;
    domain(context, &attempt, command, Some(session))
        .await
        .map(|_| ())
}
async fn authorize_history(
    context: &Context<impl BotApi>,
    session: &SessionId,
) -> Result<(), DomainError> {
    let snapshot = context
        .inspect(session)
        .await?
        .ok_or_else(|| DomainError::NotFound(session.clone()))?;
    authorize_workspace(&snapshot.cwd, &context.config.workspace)
        .await
        .map(|_| ())
}
pub(crate) async fn dispatch(
    context: &Context<impl BotApi>,
    record: &InboxRecord,
) -> Result<Option<(TopicKey, String)>, DomainError> {
    let topic = &record.command.topic;
    let reply = match &record.command.action {
        TelegramAction::Rejected(reason) => rejected(reason).into(),
        TelegramAction::Prompt { session, prompt } => {
            submit_prompt(context, record, session, prompt, record.operation.clone()).await?;
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
            ControlCommand::Discover { session } => {
                authorize_history(context, session).await?;
                if context.store.binding(topic).await?.as_ref() != Some(session) {
                    return Err(DomainError::OperationConflict);
                }
                context.app.discover_session(session.clone()).await?;
                "Provider ready without a business prompt. Use /menu models or /menu modes to select actual choices.".into()
            }
            ControlCommand::Queue => {
                let pending = context.store.pending(context.config.inbox_capacity).await?;
                let ids: Vec<_> = pending
                    .iter()
                    .filter(|item| {
                        item.command.topic == *topic
                            && matches!(&item.command.action, TelegramAction::Prompt { .. })
                    })
                    .map(|item| item.id.get())
                    .collect();
                format!("Queued input IDs: {ids:?}. /stop cancels earlier queued inputs; /interrupt TEXT stops and replaces them. Accepted running work is shown by /status.")
            }
            ControlCommand::Interrupt { session, prompt } => {
                authorize_history(context, session).await?;
                let cancelled = context.store.queue_barrier(record.id).await?;
                match domain(
                    context,
                    record,
                    DomainCommand::Cancel {
                        session: session.clone(),
                    },
                    Some(session),
                )
                .await
                {
                    Ok(_) | Err(DomainError::NoActiveTurn) => {}
                    Err(error) => return Err(error),
                }
                submit_prompt(
                    context,
                    record,
                    session,
                    prompt,
                    OperationId::new(format!("interrupt-input-{}", record.id.get()))?,
                )
                .await?;
                format!("Interrupted; replacement input accepted. Cancelled queued inputs: {cancelled:?}")
            }
            ControlCommand::Menu { page, create_topic } => {
                super::menu::build(context, record, page, *create_topic).await?
            }
            ControlCommand::Notifications { enabled } | ControlCommand::Silent { enabled } => {
                context
                    .store
                    .preference_reply(
                        topic,
                        record.id,
                        if matches!(control, ControlCommand::Notifications { .. }) {
                            TopicPreference::Notifications(*enabled)
                        } else {
                            TopicPreference::Silent(*enabled)
                        },
                    )
                    .await?
            }
            ControlCommand::NewSession {
                harness,
                cwd,
                create_topic,
            } => {
                if authorize_workspace(cwd, &context.config.workspace).await? != *cwd {
                    return Err(DomainError::InvalidAnswer(
                        "workspace identity changed".into(),
                    ));
                }
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
                let CommandReceipt::Created { summary: snapshot } = events else {
                    return Err(DomainError::Persistence(
                        "create receipt missing summary".into(),
                    ));
                };
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
                let CommandReceipt::Loaded { view: snapshot } = events else {
                    return Err(DomainError::Persistence("load receipt missing view".into()));
                };
                authorize_workspace(&snapshot.cwd, &context.config.workspace).await?;
                context.store.bind(topic.clone(), session.clone()).await?;
                format!("Attached session {session}")
            }
            ControlCommand::History { session, all } => {
                let saved = context
                    .app
                    .delivery_payloads()
                    .find_notice(&NoticeId::new(format!(
                        "history-result-{}",
                        record.id.get()
                    ))?)
                    .await?
                    .is_some();
                let cwd = if saved {
                    None
                } else {
                    let snapshot = context
                        .inspect(session)
                        .await?
                        .ok_or_else(|| DomainError::NotFound(session.clone()))?;
                    let canonical =
                        authorize_workspace(&snapshot.cwd, &context.config.workspace).await?;
                    if canonical != snapshot.cwd {
                        return Err(DomainError::InvalidAnswer(
                            "workspace identity changed".into(),
                        ));
                    }
                    Some(canonical)
                };
                context
                    .store
                    .history_reply(crate::persistence::inbox::HistoryExport {
                        topic: topic.clone(),
                        update: record.id,
                        session: session.clone(),
                        cwd,
                        all: *all,
                    })
                    .await?
            }
            ControlCommand::Sync {
                cursor,
                recent,
                forum,
            } => super::sync::run(context, record, cursor, *recent, *forum).await?,
            ControlCommand::Status { session } => {
                let events = domain(
                    context,
                    record,
                    DomainCommand::Inspect(session.clone()),
                    Some(session),
                )
                .await?;
                let CommandReceipt::Loaded { view: snapshot } = events else {
                    return Err(DomainError::Persistence(
                        "status receipt missing view".into(),
                    ));
                };
                render::status(&snapshot)
            }
            ControlCommand::ListSessions => {
                let page = context.app.list(None, None).await?;
                let mut text = String::new();
                for session in page.sessions {
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
                if page.next_cursor.is_some() {
                    text.push_str("仅显示最新一页会话。\n");
                }
                if text.is_empty() {
                    "暂无授权会话。使用 /new。".into()
                } else {
                    text
                }
            }
            ControlCommand::Cancel { session } => {
                authorize_history(context, session).await?;
                let cancelled = context.store.queue_barrier(record.id).await?;
                match domain(
                    context,
                    record,
                    DomainCommand::Cancel {
                        session: session.clone(),
                    },
                    Some(session),
                )
                .await
                {
                    Ok(_) | Err(DomainError::NoActiveTurn) => {}
                    Err(error) => return Err(error),
                }
                format!("Cancelled. Cancelled queued inputs: {cancelled:?}")
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
            ControlCommand::SetOption { session, id, value } => {
                domain(
                    context,
                    record,
                    DomainCommand::SetOption {
                        session: session.clone(),
                        id: id.clone(),
                        value: value.clone(),
                    },
                    Some(session),
                )
                .await?;
                format!("Setting {id}: {value}")
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
    menu: bool,
) -> Result<(), DomainError> {
    let notice = NoticeId::new(format!(
        "{}reply-{}",
        if menu { "menu-" } else { "" },
        record.id.get()
    ))?;
    let notice_content = NoticeContent { id: notice, text };
    let content = crate::persistence::payload::PayloadStore::notice_ref(&notice_content)?;
    context
        .app
        .delivery_payloads()
        .put_notice(&notice_content)
        .await?;
    let bot_id = context.bot_id;
    context
        .app
        .delivery_store()
        .enqueue(DeliveryEvent {
            id: DeliveryId::new(format!("reply-{}", record.id.get()))?,
            revision: crate::domain::query::SafeInteger::new(record.id.get())
                .map_err(|error| DomainError::Persistence(error.to_string()))?,
            target: topic.delivery_target(bot_id, context.config.workspace.clone()),
            payload: if menu {
                DeliveryPayload::Menu { content }
            } else {
                DeliveryPayload::Notice { content }
            },
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
    // Menu errors also freeze their reply before inbox completion. Use the
    // distinct typed archive identity, never parse reply text to infer success.
    if matches!(
        &record.command.action,
        TelegramAction::Control(ControlCommand::Menu { .. } | ControlCommand::Sync { .. })
    ) {
        let notice = NoticeId::new(format!("reply-{}", record.id.get()))?;
        if let Some(saved) = context.app.delivery_payloads().find_notice(&notice).await? {
            queue_notice(
                context,
                record,
                record.command.topic.clone(),
                saved.text,
                false,
            )
            .await?;
            return context
                .store
                .complete(record.id, InboxOutcome::Failed)
                .await;
        }
    }
    if matches!(
        &record.command.action,
        TelegramAction::Control(ControlCommand::History { .. })
    ) {
        let success = NoticeId::new(format!("history-result-{}", record.id.get()))?;
        let error = NoticeId::new(format!("reply-{}", record.id.get()))?;
        if context
            .app
            .delivery_payloads()
            .find_notice(&success)
            .await?
            .is_none()
        {
            if let Some(saved) = context.app.delivery_payloads().find_notice(&error).await? {
                queue_notice(
                    context,
                    record,
                    record.command.topic.clone(),
                    saved.text,
                    false,
                )
                .await?;
                return context
                    .store
                    .complete(record.id, InboxOutcome::Failed)
                    .await;
            }
        }
    }
    let dispatched = dispatch(context, record).await;
    if matches!(&dispatched, Err(DomainError::Busy))
        && matches!(
            &record.command.action,
            TelegramAction::Prompt { .. }
                | TelegramAction::Control(ControlCommand::Interrupt { .. })
        )
    {
        // A known unaccepted Busy keeps the durable input queued. Its attempt
        // ID is replaced only after querying that exact terminal rejection.
        return Ok(());
    }
    if context.app.is_closing() && !matches!(dispatched, Err(DomainError::Persistence(_))) {
        // Keep the durable classification pending. Accepted domain operations
        // settle in the host; restart can recover their immutable receipts.
        return Err(DomainError::Backpressure);
    }
    let menu = matches!(
        &record.command.action,
        TelegramAction::Control(ControlCommand::Menu { .. } | ControlCommand::Sync { .. })
    ) && dispatched.is_ok();
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
        queue_notice(context, record, topic, text, menu).await?;
    }
    context.store.complete(record.id, outcome).await
}
