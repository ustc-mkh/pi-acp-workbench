//! Targeted Telegram SQL, executed only on the shared database thread.
use super::inbox::{self, failure, Action, Admission, AdmissionResult, Output, Request};
use crate::{
    domain::{error::DomainError, query::SafeInteger, SessionId},
    telegram::{
        command::TelegramAction,
        state::{InboxRecord, InboxStatus},
        types::{CallbackBinding, CallbackKey, TopicKey, UserId},
    },
};
use rusqlite::{params, Connection, Row};
use serde::Serialize;
#[cfg(test)]
#[path = "telegram_scale_tests.rs"]
mod scale_tests;

fn json(value: &impl Serialize) -> Result<String, DomainError> {
    serde_json::to_string(value).map_err(failure)
}
fn safe(value: u64) -> Result<SafeInteger, DomainError> {
    SafeInteger::new(value).map_err(failure)
}
fn meta(db: &Connection) -> Result<Option<(UserId, u64)>, DomainError> {
    let mut statement = db
        .prepare("SELECT bot_id,offset,owner_json FROM telegram_meta")
        .map_err(failure)?;
    let mut rows = statement.query([]).map_err(failure)?;
    let Some(row) = rows.next().map_err(failure)? else {
        return Ok(None);
    };
    let bot = UserId::new(row.get(0).map_err(failure)?)?;
    let offset: SafeInteger = row.get(1).map_err(failure)?;
    let owner: UserId =
        serde_json::from_str(&row.get::<_, String>(2).map_err(failure)?).map_err(failure)?;
    if owner != bot || rows.next().map_err(failure)?.is_some() {
        return Err(failure("Telegram bot identity mismatch"));
    }
    Ok(Some((bot, offset.get())))
}
fn binding_row(row: &Row<'_>) -> Result<(TopicKey, SessionId), DomainError> {
    let pair: (TopicKey, SessionId) =
        serde_json::from_str(&row.get::<_, String>(3).map_err(failure)?).map_err(failure)?;
    if pair.0.chat.get() != row.get::<_, i64>(0).map_err(failure)?
        || pair.0.thread.map_or(0, |t| t.get()) != row.get::<_, i64>(1).map_err(failure)?
        || pair.1.as_str() != row.get::<_, String>(2).map_err(failure)?
    {
        return Err(failure("Telegram binding identity mismatch"));
    }
    Ok(pair)
}
fn binding(db: &Connection, bot: i64, topic: &TopicKey) -> Result<Option<SessionId>, DomainError> {
    let mut statement = db.prepare("SELECT chat,thread,session,binding_json FROM telegram_bindings WHERE bot_id=?1 AND chat=?2 AND thread=?3").map_err(failure)?;
    let mut rows = statement
        .query(params![
            bot,
            topic.chat.get(),
            topic.thread.map_or(0, |t| t.get())
        ])
        .map_err(failure)?;
    rows.next()
        .map_err(failure)?
        .map(binding_row)
        .transpose()
        .map(|pair| pair.map(|(_, session)| session))
}
fn topic(db: &Connection, bot: i64, session: &SessionId) -> Result<Option<TopicKey>, DomainError> {
    let mut statement = db.prepare("SELECT chat,thread,session,binding_json FROM telegram_bindings WHERE bot_id=?1 AND session=?2").map_err(failure)?;
    let mut rows = statement
        .query(params![bot, session.as_str()])
        .map_err(failure)?;
    rows.next()
        .map_err(failure)?
        .map(binding_row)
        .transpose()
        .map(|pair| pair.map(|(topic, _)| topic))
}
fn callback(
    db: &Connection,
    bot: i64,
    key: &CallbackKey,
) -> Result<Option<CallbackBinding>, DomainError> {
    let mut statement = db.prepare("SELECT key,binding_json,expires_at,used_by FROM telegram_callbacks WHERE bot_id=?1 AND key=?2").map_err(failure)?;
    let mut rows = statement
        .query(params![bot, key.as_str()])
        .map_err(failure)?;
    let Some(row) = rows.next().map_err(failure)? else {
        return Ok(None);
    };
    let value: CallbackBinding =
        serde_json::from_str(&row.get::<_, String>(1).map_err(failure)?).map_err(failure)?;
    let expires: SafeInteger = row.get(2).map_err(failure)?;
    let used: Option<SafeInteger> = row.get(3).map_err(failure)?;
    if row.get::<_, String>(0).map_err(failure)? != key.as_str()
        || expires.get() != value.expires_at
        || used.map(|v| v.get()) != value.used_by.map(|v| v.get())
    {
        return Err(failure("Telegram callback identity mismatch"));
    }
    Ok(Some(value))
}
fn put_callback(
    db: &Connection,
    bot: i64,
    key: &CallbackKey,
    value: &CallbackBinding,
) -> Result<(), DomainError> {
    let encoded = json(value)?;
    if let Some(mut existing) = callback(db, bot, key)? {
        existing.used_by = value.used_by;
        if json(&existing)? != encoded {
            return Err(failure("Telegram callback identity conflict"));
        }
        db.execute(
            "UPDATE telegram_callbacks SET binding_json=?1,used_by=?2 WHERE bot_id=?3 AND key=?4",
            params![
                encoded,
                value.used_by.map(|v| safe(v.get())).transpose()?,
                bot,
                key.as_str()
            ],
        )
        .map_err(failure)?;
        return Ok(());
    }
    db.execute("INSERT INTO telegram_callbacks(bot_id,key,binding_json,expires_at,used_by) VALUES (?1,?2,?3,?4,?5)", params![bot, key.as_str(), encoded, safe(value.expires_at)?, value.used_by.map(|v| safe(v.get())).transpose()?]).map_err(failure)?;
    Ok(())
}
const INBOX_COLUMNS: &str = "update_id,command_json,operation,callback_ref,status,outcome_json";
fn record(
    db: &Connection,
    bot: i64,
    offset: u64,
    row: &Row<'_>,
) -> Result<InboxRecord, DomainError> {
    let id: SafeInteger = row.get(0).map_err(failure)?;
    let record: InboxRecord =
        serde_json::from_str(&row.get::<_, String>(1).map_err(failure)?).map_err(failure)?;
    let (status, outcome) = match &record.status {
        InboxStatus::Pending => ("Pending", None),
        InboxStatus::Completed(value) => ("Completed", Some(json(value)?)),
    };
    if record.id.get() != id.get()
        || record.operation != inbox::operation(record.id)?
        || record.operation.as_str() != row.get::<_, String>(2).map_err(failure)?
        || record.callback.as_ref().map(|v| v.as_str())
            != row.get::<_, Option<String>>(3).map_err(failure)?.as_deref()
        || status != row.get::<_, String>(4).map_err(failure)?
        || outcome != row.get::<_, Option<String>>(5).map_err(failure)?
        || offset <= id.get()
    {
        return Err(failure("Telegram inbox identity/offset mismatch"));
    }
    // Completed receipts outlive callback compaction. Pending receipts may not.
    if matches!(record.status, InboxStatus::Pending) {
        if let Some(key) = &record.callback {
            if callback(db, bot, key)?.and_then(|b| b.used_by) != Some(record.id) {
                return Err(failure("Telegram callback receipt missing"));
            }
        }
    }
    Ok(record)
}
fn pending(
    db: &Connection,
    bot: i64,
    offset: u64,
    limit: usize,
) -> Result<Vec<InboxRecord>, DomainError> {
    let mut statement = db.prepare(&format!("SELECT {INBOX_COLUMNS} FROM telegram_inbox WHERE bot_id=?1 AND status='Pending' ORDER BY update_id LIMIT ?2")).map_err(failure)?;
    let mut rows = statement
        .query(params![bot, i64::try_from(limit).map_err(failure)?])
        .map_err(failure)?;
    let mut output = Vec::new();
    while let Some(row) = rows.next().map_err(failure)? {
        output.push(record(db, bot, offset, row)?);
    }
    Ok(output)
}
fn admit(
    db: &Connection,
    bot: i64,
    offset: u64,
    admission: Admission,
    max_pending: usize,
) -> Result<Output, DomainError> {
    if admission.id.get() < offset {
        return Ok(Output::Admission(AdmissionResult::Duplicate));
    }
    if let Some(command) = &admission.command {
        if binding(db, bot, &command.topic)? != admission.expected_binding {
            return Err(DomainError::Backpressure);
        }
        let count: i64 = db.query_row("SELECT count(*) FROM (SELECT 1 FROM telegram_inbox WHERE bot_id=?1 AND status='Pending' LIMIT ?2)", params![bot, i64::try_from(max_pending).map_err(failure)?], |row| row.get(0)).map_err(failure)?;
        if count as usize >= max_pending {
            return Err(DomainError::Backpressure);
        }
    }
    if admission
        .callback_query
        .as_ref()
        .is_some_and(|q| q.is_empty() || q.len() > 200 || q.chars().any(char::is_control))
    {
        return Err(DomainError::InvalidAnswer(
            "invalid callback query identity".into(),
        ));
    }
    if let Some(key) = &admission.callback {
        let mut value = callback(db, bot, key)?
            .ok_or_else(|| DomainError::InvalidAnswer("callback not found".into()))?;
        let command = admission
            .command
            .as_ref()
            .ok_or_else(|| DomainError::InvalidAnswer("callback command missing".into()))?;
        match &command.action {
            TelegramAction::Answer { session, answer }
                if value.used_by.is_none()
                    && value.topic == command.topic
                    && &value.session == session
                    && &value.answer == answer =>
            {
                value.used_by = Some(admission.id)
            }
            _ => {
                return Err(DomainError::InvalidAnswer(
                    "callback already used or binding mismatch".into(),
                ))
            }
        }
        put_callback(db, bot, key, &value)?;
    }
    let next = safe(admission.id.get() + 1)?;
    let result = if let Some(command) = admission.command {
        let record = InboxRecord {
            id: admission.id,
            sender: admission
                .sender
                .ok_or_else(|| DomainError::InvalidAnswer("inbox sender missing".into()))?,
            operation: inbox::operation(admission.id)?,
            command,
            callback: admission.callback,
            callback_query: admission.callback_query,
            status: InboxStatus::Pending,
        };
        db.execute("INSERT INTO telegram_inbox(bot_id,update_id,command_json,operation,callback_ref,status) VALUES (?1,?2,?3,?4,?5,'Pending')", params![bot, safe(record.id.get())?, json(&record)?, record.operation.as_str(), record.callback.as_ref().map(|key| key.as_str())]).map_err(failure)?;
        AdmissionResult::Accepted
    } else {
        AdmissionResult::Ignored
    };
    db.execute(
        "UPDATE telegram_meta SET offset=?2 WHERE bot_id=?1",
        params![bot, next],
    )
    .map_err(failure)?;
    Ok(Output::Admission(result))
}
fn execute_action(
    db: &Connection,
    action: Action,
    max_pending: usize,
) -> Result<Output, DomainError> {
    let current = meta(db)?;
    if let Action::Claim(bot) = action {
        if current.is_some_and(|(old, _)| old != bot) {
            return Err(failure("Telegram state belongs to another bot"));
        }
        db.execute("INSERT INTO telegram_meta(bot_id,offset,owner_json) VALUES (?1,0,?2) ON CONFLICT(bot_id) DO NOTHING", params![bot.get(), json(&bot)?]).map_err(failure)?;
        return Ok(Output::Unit);
    }
    // Read-only APIs have meaningful empty values before the initial claim.
    let (bot, offset) = current.map_or((0, 0), |(bot, offset)| (bot.get(), offset));
    match action {
        Action::Offset => Ok(Output::Offset(offset)),
        Action::Binding(key) => Ok(Output::Binding(binding(db, bot, &key)?)),
        Action::Topic(session) => Ok(Output::Topic(topic(db, bot, &session)?)),
        Action::Callback(key) => Ok(Output::Callback(callback(db, bot, &key)?)),
        Action::Pending(limit) => Ok(Output::Pending(pending(db, bot, offset, limit)?)),
        Action::Compact(_) if current.is_none() => Ok(Output::Compacted(0, 0)),
        #[cfg(test)]
        Action::Snapshot => snapshot(db, current),
        action => {
            if current.is_none() {
                return Err(failure("Telegram bot must be claimed before admission"));
            }
            match action {
                Action::Bind(key, session) => {
                    if topic(db, bot, &session)?.is_some_and(|old| old != key) {
                        return Err(DomainError::InvalidAnswer(
                            "session already bound to another Telegram topic".into(),
                        ));
                    }
                    binding(db, bot, &key)?;
                    db.execute("INSERT INTO telegram_bindings(bot_id,chat,thread,session,binding_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(bot_id,chat,thread) DO UPDATE SET session=excluded.session,binding_json=excluded.binding_json", params![bot, key.chat.get(), key.thread.map_or(0, |t| t.get()), session.as_str(), json(&(&key, &session))?]).map_err(failure)?;
                }
                Action::Unbind(key, expected) => {
                    if binding(db, bot, &key)?.as_ref() == Some(&expected) {
                        db.execute("DELETE FROM telegram_bindings WHERE bot_id=?1 AND chat=?2 AND thread=?3", params![bot, key.chat.get(), key.thread.map_or(0, |t| t.get())]).map_err(failure)?;
                    }
                }
                Action::Register(key, value) => {
                    if let Some(existing) = callback(db, bot, &key)? {
                        let mut expected = value;
                        expected.used_by = existing.used_by;
                        if json(&existing)? != json(&expected)? {
                            return Err(DomainError::OperationConflict);
                        }
                    } else {
                        let count: i64 = db.query_row("SELECT count(*) FROM (SELECT 1 FROM telegram_callbacks WHERE bot_id=?1 LIMIT 4096)", [bot], |row| row.get(0)).map_err(failure)?;
                        if count >= 4096 {
                            return Err(DomainError::Backpressure);
                        }
                        if value.used_by.is_some() {
                            return Err(DomainError::InvalidAnswer(
                                "callback cannot start consumed".into(),
                            ));
                        }
                        put_callback(db, bot, &key, &value)?;
                    }
                }
                Action::Admit(admission) => return admit(db, bot, offset, admission, max_pending),
                Action::Complete(id, outcome) => {
                    let mut statement = db.prepare(&format!("SELECT {INBOX_COLUMNS} FROM telegram_inbox WHERE bot_id=?1 AND update_id=?2")).map_err(failure)?;
                    let mut rows = statement
                        .query(params![bot, safe(id.get())?])
                        .map_err(failure)?;
                    let mut value = record(
                        db,
                        bot,
                        offset,
                        rows.next()
                            .map_err(failure)?
                            .ok_or_else(|| failure("inbox record missing"))?,
                    )?;
                    if matches!(value.status, InboxStatus::Pending) {
                        value.status = InboxStatus::Completed(outcome.clone());
                        db.execute("UPDATE telegram_inbox SET command_json=?3,status='Completed',outcome_json=?4 WHERE bot_id=?1 AND update_id=?2", params![bot, safe(id.get())?, json(&value)?, json(&outcome)?]).map_err(failure)?;
                    }
                }
                Action::Compact(now) => {
                    let inbox = db
                        .execute(
                            "DELETE FROM telegram_inbox WHERE bot_id=?1 AND status='Completed'",
                            [bot],
                        )
                        .map_err(failure)?;
                    let callbacks = db.execute("DELETE FROM telegram_callbacks AS c WHERE bot_id=?1 AND expires_at<=?2 AND NOT EXISTS (SELECT 1 FROM telegram_inbox i WHERE i.bot_id=c.bot_id AND i.status='Pending' AND i.callback_ref=c.key)", params![bot, safe(now)?]).map_err(failure)?;
                    return Ok(Output::Compacted(inbox, callbacks));
                }
                _ => unreachable!(),
            }
            Ok(Output::Unit)
        }
    }
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    let result = (|| {
        let tx = db.transaction().map_err(failure)?;
        let output = execute_action(&tx, request.action, request.max_pending)?;
        tx.commit().map_err(failure)?;
        Ok(output)
    })();
    let _ = request.reply.send(result);
}

/// Deliberately test-only full inspection, never used to implement a mutation.
#[cfg(test)]
fn snapshot(db: &Connection, current: Option<(UserId, u64)>) -> Result<Output, DomainError> {
    use crate::telegram::state::TelegramState;
    let mut state = TelegramState::default();
    let Some((bot, offset)) = current else {
        return Ok(Output::Snapshot(state));
    };
    state.bot = Some(bot);
    state.offset = offset;
    let bot = bot.get();
    let mut statement = db
        .prepare("SELECT chat,thread,session,binding_json FROM telegram_bindings WHERE bot_id=?1")
        .map_err(failure)?;
    let mut rows = statement.query([bot]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let (key, value) = binding_row(row)?;
        state.bindings.insert(key, value);
    }
    let mut statement = db
        .prepare("SELECT key FROM telegram_callbacks WHERE bot_id=?1")
        .map_err(failure)?;
    let keys = statement
        .query_map([bot], |row| row.get::<_, String>(0))
        .map_err(failure)?;
    for key in keys {
        let key = CallbackKey::try_from(key.map_err(failure)?)?;
        let value = callback(db, bot, &key)?.expect("selected callback");
        state.callbacks.insert(key, value);
    }
    let mut statement = db
        .prepare(&format!(
            "SELECT {INBOX_COLUMNS} FROM telegram_inbox WHERE bot_id=?1 ORDER BY update_id"
        ))
        .map_err(failure)?;
    let mut rows = statement.query([bot]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let value = record(db, bot, offset, row)?;
        state.inbox.insert(value.id, value);
    }
    Ok(Output::Snapshot(state))
}
