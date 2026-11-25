//! Existing inbox is the input queue. Only known Busy rejections may get a
//! new attempt ID; unknown/accepted operations always recover the original ID.
use super::*;
use crate::{
    domain::{
        transition::{DeliveryIntent, DeliveryPayload},
        DeliveryId, NoticeId, OperationId,
    },
    persistence::payload::{notice_content, notice_optional, NoticeContent},
    telegram::command::ControlCommand,
};
fn source(record: &InboxRecord) -> Option<&SessionId> {
    match &record.command.action {
        TelegramAction::Prompt { session, .. }
        | TelegramAction::Control(
            ControlCommand::Interrupt { session, .. } | ControlCommand::Cancel { session },
        ) => Some(session),
        _ => None,
    }
}
pub(super) fn attempt(
    db: &Connection,
    bot: i64,
    offset: u64,
    id: UpdateId,
    change: Option<(Option<OperationId>, OperationId)>,
) -> Result<Output, DomainError> {
    let record = inbox_record(db, bot, offset, id)?;
    if source(&record).is_none() {
        return Err(DomainError::OperationConflict);
    }
    let current: Option<String> = db
        .query_row(
            "SELECT operation FROM telegram_prompt_attempts WHERE bot_id=?1 AND update_id=?2",
            params![bot, safe(id.get())?],
            |row| row.get(0),
        )
        .optional()
        .map_err(failure)?;
    let current = current.map(OperationId::new).transpose()?;
    if let Some((expected, next)) = change {
        if !matches!(record.status, InboxStatus::Pending)
            || expected != current
            || binding(db, bot, &record.command.topic)?.as_ref() != source(&record)
        {
            return Err(DomainError::OperationConflict);
        }
        db.execute("INSERT INTO telegram_prompt_attempts(bot_id,update_id,operation) VALUES (?1,?2,?3) ON CONFLICT(bot_id,update_id) DO UPDATE SET operation=excluded.operation", params![bot, safe(id.get())?, next.as_str()]).map_err(failure)?;
        Ok(Output::Attempt(Some(next)))
    } else {
        Ok(Output::Attempt(current))
    }
}
pub(super) fn barrier(
    db: &Connection,
    bot: i64,
    offset: u64,
    id: UpdateId,
    limit: usize,
) -> Result<Output, DomainError> {
    let control = inbox_record(db, bot, offset, id)?;
    if !matches!(
        &control.command.action,
        TelegramAction::Control(ControlCommand::Cancel { .. } | ControlCommand::Interrupt { .. })
    ) {
        return Err(DomainError::OperationConflict);
    }
    let notice = NoticeId::new(format!("queue-barrier-{}", id.get()))?;
    if let Some(saved) = notice_optional(db, notice.clone()).map_err(failure)? {
        return Ok(Output::Barrier(
            serde_json::from_str(&saved.text).map_err(failure)?,
        ));
    }
    if binding(db, bot, &control.command.topic)?.as_ref() != source(&control) {
        return Err(DomainError::OperationConflict);
    }
    let mut cancelled = vec![];
    for record in pending(db, bot, offset, limit)? {
        if record.id >= id
            || record.command.topic != control.command.topic
            || source(&record) != source(&control)
            || !matches!(&record.command.action, TelegramAction::Prompt { .. })
        {
            continue;
        }
        cancelled.push(record.id);
        complete_record(db, bot, record, InboxOutcome::Cancelled { by: id })?;
    }
    let content = notice_content(&NoticeContent {
        id: notice,
        text: json(&cancelled)?,
    })
    .map_err(failure)?;
    super::super::content::put_text(db, &content).map_err(failure)?;
    Ok(Output::Barrier(cancelled))
}
pub(super) fn queued_notice(
    db: &Connection,
    bot: i64,
    record: &InboxRecord,
) -> Result<(), DomainError> {
    let TelegramAction::Prompt { session, .. } = &record.command.action else {
        return Ok(());
    };
    let view = match super::super::query::view(db, session) {
        Ok(view) => view,
        Err(crate::persistence::database::StoreError::NotFound) => return Ok(()),
        Err(error) => return Err(failure(error)),
    };
    let count: i64 = db.query_row("SELECT count(*) FROM (SELECT 1 FROM telegram_inbox WHERE bot_id=?1 AND status='Pending' AND update_id<?2 AND json_extract(command_json,'$.command.topic')=?3 AND json_extract(command_json,'$.command.action.Prompt.session')=?4 LIMIT 128)", params![bot, safe(record.id.get())?, json(&record.command.topic)?, session.as_str()], |row| row.get(0)).map_err(failure)?;
    if view.active_turn.is_none() && count == 0 {
        return Ok(());
    }
    notice(db, bot, &record.command.topic, view.cwd, record.id, "queued",
        format!("Input {} queued ({count} earlier inputs). /queue shows pending IDs; /stop cancels earlier queued inputs; /interrupt TEXT stops then replaces them.", record.id.get()))
}
pub(super) fn notice(
    db: &Connection,
    bot: i64,
    topic: &TopicKey,
    cwd: crate::domain::WorkspacePath,
    update: UpdateId,
    kind: &str,
    text: String,
) -> Result<(), DomainError> {
    let key = format!("{kind}-{}", update.get());
    let notice = NoticeContent {
        id: NoticeId::new(&key)?,
        text,
    };
    let value = notice_content(&notice).map_err(failure)?;
    super::super::content::put_text(db, &value).map_err(failure)?;
    super::super::query::put_delivery(
        db,
        &DeliveryIntent {
            id: DeliveryId::new(key)?,
            revision: safe(update.get())?,
            target: topic.delivery_target(bot, cwd),
            payload: DeliveryPayload::Notice {
                content: value.content,
            },
        },
    )
    .map_err(failure)?;
    Ok(())
}
