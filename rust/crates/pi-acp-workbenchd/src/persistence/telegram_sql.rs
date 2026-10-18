//! Normalized Telegram rows, accessed only by the shared database executor.
use super::inbox::{self, Action, Request};
use crate::{
    domain::{error::DomainError, query::SafeInteger, SessionId},
    telegram::{
        state::{InboxRecord, InboxStatus, TelegramState},
        types::{CallbackBinding, CallbackKey, TopicKey, UpdateId, UserId},
    },
};
use inbox::failure;
use rusqlite::{params, Connection};
use serde::Serialize;
fn json(value: &impl Serialize) -> Result<String, DomainError> {
    serde_json::to_string(value).map_err(failure)
}
fn status(record: &InboxRecord) -> &'static str {
    match record.status {
        InboxStatus::Pending => "Pending",
        InboxStatus::Completed(_) => "Completed",
    }
}
fn outcome(record: &InboxRecord) -> Result<Option<String>, DomainError> {
    match &record.status {
        InboxStatus::Pending => Ok(None),
        InboxStatus::Completed(value) => Ok(Some(json(value)?)),
    }
}
fn load(db: &Connection) -> Result<TelegramState, DomainError> {
    let mut state = TelegramState::default();
    let mut statement = db
        .prepare("SELECT bot_id,offset,owner_json FROM telegram_meta")
        .map_err(failure)?;
    let mut rows = statement.query([]).map_err(failure)?;
    if let Some(row) = rows.next().map_err(failure)? {
        let bot = UserId::new(row.get(0).map_err(failure)?)?;
        let offset: SafeInteger = row.get(1).map_err(failure)?;
        let owner: UserId =
            serde_json::from_str(&row.get::<_, String>(2).map_err(failure)?).map_err(failure)?;
        if bot != owner || rows.next().map_err(failure)?.is_some() {
            return Err(failure("Telegram bot identity mismatch"));
        }
        state.bot = Some(bot);
        state.offset = offset.get();
    } else {
        return Ok(state);
    }
    let bot = state.bot.expect("validated bot").get();
    let mut statement = db
        .prepare("SELECT chat,thread,session,binding_json FROM telegram_bindings WHERE bot_id=?1")
        .map_err(failure)?;
    let mut rows = statement.query([bot]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let pair: (TopicKey, SessionId) =
            serde_json::from_str(&row.get::<_, String>(3).map_err(failure)?).map_err(failure)?;
        if pair.0.chat.get() != row.get::<_, i64>(0).map_err(failure)?
            || pair.0.thread.map_or(0, |t| t.get()) != row.get::<_, i64>(1).map_err(failure)?
            || pair.1.as_str() != row.get::<_, String>(2).map_err(failure)?
        {
            return Err(failure("Telegram binding identity mismatch"));
        }
        if state.bindings.insert(pair.0, pair.1).is_some() {
            return Err(failure("duplicate Telegram binding"));
        }
    }
    let mut statement = db
        .prepare(
            "SELECT key,binding_json,expires_at,used_by FROM telegram_callbacks WHERE bot_id=?1",
        )
        .map_err(failure)?;
    let mut rows = statement.query([bot]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let key = CallbackKey::try_from(row.get::<_, String>(0).map_err(failure)?)?;
        let binding: CallbackBinding =
            serde_json::from_str(&row.get::<_, String>(1).map_err(failure)?).map_err(failure)?;
        let expires: SafeInteger = row.get(2).map_err(failure)?;
        let used: Option<SafeInteger> = row.get(3).map_err(failure)?;
        if expires.get() != binding.expires_at
            || used.map(|v| v.get()) != binding.used_by.map(|v| v.get())
        {
            return Err(failure("Telegram callback identity mismatch"));
        }
        state.callbacks.insert(key, binding);
    }
    let mut statement = db.prepare("SELECT update_id,command_json,operation,callback_ref,status,outcome_json FROM telegram_inbox WHERE bot_id=?1").map_err(failure)?;
    let mut rows = statement.query([bot]).map_err(failure)?;
    while let Some(row) = rows.next().map_err(failure)? {
        let id: SafeInteger = row.get(0).map_err(failure)?;
        let record: InboxRecord =
            serde_json::from_str(&row.get::<_, String>(1).map_err(failure)?).map_err(failure)?;
        if record.id.get() != id.get()
            || record.operation != inbox::operation(record.id)?
            || record.operation.as_str() != row.get::<_, String>(2).map_err(failure)?
            || record.callback.as_ref().map(|v| v.as_str())
                != row.get::<_, Option<String>>(3).map_err(failure)?.as_deref()
            || status(&record) != row.get::<_, String>(4).map_err(failure)?
            || outcome(&record)? != row.get::<_, Option<String>>(5).map_err(failure)?
            || state.offset <= id.get()
        {
            return Err(failure("Telegram inbox identity/offset mismatch"));
        }
        if record
            .callback
            .as_ref()
            .is_some_and(|key| state.callbacks.get(key).and_then(|b| b.used_by) != Some(record.id))
        {
            return Err(failure("Telegram callback receipt missing"));
        }
        state.inbox.insert(UpdateId::new(id.get())?, record);
    }
    Ok(state)
}
fn save(db: &Connection, old: &TelegramState, next: &TelegramState) -> Result<(), DomainError> {
    let bot = next
        .bot
        .ok_or_else(|| failure("Telegram bot must be claimed before admission"))?
        .get();
    SafeInteger::new(next.offset).map_err(failure)?;
    if old.bot != next.bot || old.offset != next.offset {
        db.execute("INSERT INTO telegram_meta(bot_id,offset,owner_json) VALUES (?1,?2,?3) ON CONFLICT(bot_id) DO UPDATE SET offset=excluded.offset", params![bot, SafeInteger::new(next.offset).map_err(failure)?, json(&next.bot)?]).map_err(failure)?;
    }
    for key in old
        .bindings
        .keys()
        .filter(|k| !next.bindings.contains_key(*k))
    {
        db.execute(
            "DELETE FROM telegram_bindings WHERE bot_id=?1 AND chat=?2 AND thread=?3",
            params![bot, key.chat.get(), key.thread.map_or(0, |t| t.get())],
        )
        .map_err(failure)?;
    }
    for (key, session) in &next.bindings {
        if old.bindings.get(key) != Some(session) {
            db.execute("INSERT INTO telegram_bindings(bot_id,chat,thread,session,binding_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(bot_id,chat,thread) DO UPDATE SET session=excluded.session,binding_json=excluded.binding_json", params![bot, key.chat.get(), key.thread.map_or(0, |t| t.get()), session.as_str(), json(&(key, session))?]).map_err(failure)?;
        }
    }
    for key in old
        .callbacks
        .keys()
        .filter(|k| !next.callbacks.contains_key(*k))
    {
        db.execute(
            "DELETE FROM telegram_callbacks WHERE bot_id=?1 AND key=?2",
            params![bot, key.as_str()],
        )
        .map_err(failure)?;
    }
    for (key, binding) in &next.callbacks {
        if old.callbacks.get(key).map(json).transpose()? != Some(json(binding)?) {
            SafeInteger::new(binding.expires_at).map_err(failure)?;
            binding
                .used_by
                .map(|v| SafeInteger::new(v.get()))
                .transpose()
                .map_err(failure)?;
            db.execute("INSERT INTO telegram_callbacks(bot_id,key,binding_json,expires_at,used_by) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(bot_id,key) DO UPDATE SET binding_json=excluded.binding_json,expires_at=excluded.expires_at,used_by=excluded.used_by", params![bot, key.as_str(), json(binding)?, SafeInteger::new(binding.expires_at).map_err(failure)?, binding.used_by.map(|v| SafeInteger::new(v.get())).transpose().map_err(failure)?]).map_err(failure)?;
        }
    }
    for id in old.inbox.keys().filter(|id| !next.inbox.contains_key(*id)) {
        db.execute(
            "DELETE FROM telegram_inbox WHERE bot_id=?1 AND update_id=?2",
            params![bot, SafeInteger::new(id.get()).map_err(failure)?],
        )
        .map_err(failure)?;
    }
    for (id, record) in &next.inbox {
        if old.inbox.get(id).map(json).transpose()? != Some(json(record)?) {
            db.execute("INSERT INTO telegram_inbox(bot_id,update_id,command_json,operation,callback_ref,status,outcome_json) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(bot_id,update_id) DO UPDATE SET command_json=excluded.command_json,status=excluded.status,outcome_json=excluded.outcome_json", params![bot, SafeInteger::new(id.get()).map_err(failure)?, json(record)?, record.operation.as_str(), record.callback.as_ref().map(|v| v.as_str()), status(record), outcome(record)?]).map_err(failure)?;
        }
    }
    Ok(())
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    let result = (|| {
        let tx = db.transaction().map_err(failure)?;
        let old = load(&tx)?;
        if matches!(request.action, Action::Snapshot | Action::Pending(_)) {
            let mut state = old;
            let output = inbox::apply(&mut state, request.action, request.max_pending)?;
            tx.commit().map_err(failure)?;
            return Ok(output);
        }
        let mut next = old.clone();
        let output = inbox::apply(&mut next, request.action, request.max_pending)?;
        if json(&old)? != json(&next)? {
            save(&tx, &old, &next)?;
        }
        tx.commit().map_err(failure)?;
        Ok(output)
    })();
    let _ = request.reply.send(result);
}
