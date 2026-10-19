//! Durable delivery work; invoked exclusively by the database executor.
//! A dispatch window bounds reads, never admission of a committed intent.
use super::{database::StoreError, query};
use crate::domain::{
    query::{ContentKind, SafeInteger, MAX_SAFE_INTEGER},
    transition::{DeliveryIntent, DeliveryPayload, DeliveryTarget},
    DeliveryId,
};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[cfg(test)]
#[path = "dispatch_scale_tests.rs"]
mod scale_tests;

pub const MAX_DELIVERY_WINDOW: usize = 1024;
#[cfg(test)]
type BorrowedTopics<'a> = (&'a [DeliveryBinding], i64);
#[cfg(test)]
type DeliveryBinding = (crate::domain::SessionId, i64, i64);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Failure {
    Transport,
    RateLimited,
    InvalidTarget,
    PayloadUnavailable,
}
#[derive(Clone, Debug)]
pub struct PendingDelivery {
    pub intent: DeliveryIntent,
    pub order: SafeInteger,
    pub attempt: u32,
    pub retry_at: SafeInteger,
    pub last_failure: Option<Failure>,
}
#[derive(Clone, Debug)]
pub struct DispatchSnapshot {
    pub bindings:
        std::collections::BTreeMap<crate::telegram::types::TopicKey, crate::domain::SessionId>,
    pub heads: Vec<PendingDelivery>,
}

type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum Request {
    DispatchSnapshot {
        bot: i64,
        limit: usize,
        reply: Reply<DispatchSnapshot>,
    },
    Enqueue {
        intent: DeliveryIntent,
        reply: Reply<()>,
    },
    #[cfg(test)]
    Heads {
        now: SafeInteger,
        limit: usize,
        reply: Reply<Vec<PendingDelivery>>,
    },
    #[cfg(test)]
    All {
        now: SafeInteger,
        limit: usize,
        reply: Reply<Vec<PendingDelivery>>,
    },
    #[cfg(test)]
    TopicHeads {
        now: SafeInteger,
        limit: usize,
        bindings: Vec<(crate::domain::SessionId, i64, i64)>,
        bot_id: i64,
        reply: Reply<Vec<PendingDelivery>>,
    },
    Ack {
        id: DeliveryId,
        reply: Reply<()>,
    },
    Fail {
        id: DeliveryId,
        failure: Failure,
        retry_at: SafeInteger,
        reply: Reply<()>,
    },
}
pub(super) fn target_key(target: &DeliveryTarget) -> String {
    match target {
        DeliveryTarget::Session { session, .. } => format!("session:{session}"),
        DeliveryTarget::Telegram {
            bot_id,
            chat,
            thread,
            ..
        } => format!("telegram:{bot_id}:{chat}:{thread}"),
    }
}
pub(super) fn validate_intent(intent: &DeliveryIntent) -> Result<(), StoreError> {
    if let DeliveryTarget::Telegram {
        bot_id,
        chat,
        thread,
        ..
    } = &intent.target
    {
        let max = MAX_SAFE_INTEGER as i64;
        if *chat == 0
            || !(0..=max).contains(bot_id)
            || !(0..=max).contains(thread)
            || !(-max..=max).contains(chat)
        {
            return Err(StoreError::Invalid("invalid delivery target"));
        }
    }
    match &intent.payload {
        DeliveryPayload::Turn {
            session,
            first_seq,
            last_seq,
            ..
        } => {
            if first_seq.get() == 0 || first_seq > last_seq {
                return Err(StoreError::Invalid("invalid delivery turn range"));
            }
            if let DeliveryTarget::Session {
                session: target, ..
            } = &intent.target
            {
                if session != target {
                    return Err(StoreError::Invalid("delivery source identity mismatch"));
                }
            }
            Ok(())
        }
        DeliveryPayload::Notice { content } => {
            content.validate()?;
            if content.kind != ContentKind::Text {
                return Err(StoreError::Invalid("delivery notice is not text"));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
const COLUMNS: &str = "d.delivery_id,d.order_seq,d.target_key,d.target_json,d.payload_json,d.attempt,d.next_retry,d.last_failure,d.revision";
fn pending(row: &Row<'_>) -> Result<PendingDelivery, StoreError> {
    let id = DeliveryId::new(row.get::<_, String>(0)?)
        .map_err(|_| StoreError::Invalid("invalid delivery identity"))?;
    let order: SafeInteger = row.get(1)?;
    if order.get() == 0 {
        return Err(StoreError::Invalid("invalid delivery order"));
    }
    let intent = DeliveryIntent {
        id,
        revision: row.get(8)?,
        target: serde_json::from_str(&row.get::<_, String>(3)?)?,
        payload: serde_json::from_str(&row.get::<_, String>(4)?)?,
    };
    validate_intent(&intent)?;
    if row.get::<_, String>(2)? != target_key(&intent.target) {
        return Err(StoreError::Invalid("delivery target key mismatch"));
    }
    let last_failure = row
        .get::<_, Option<String>>(7)?
        .map(|value| match value.as_str() {
            "Transport" => Ok(Failure::Transport),
            "RateLimited" => Ok(Failure::RateLimited),
            "InvalidTarget" => Ok(Failure::InvalidTarget),
            "PayloadUnavailable" => Ok(Failure::PayloadUnavailable),
            _ => Err(StoreError::Invalid("invalid delivery failure")),
        })
        .transpose()?;
    Ok(PendingDelivery {
        intent,
        order,
        attempt: row.get(5)?,
        retry_at: row.get(6)?,
        last_failure,
    })
}
// Reduce the pending backlog to immutable target heads before resolving the
// current binding. No correlated scan per candidate and no JSON binding input.
fn dispatch_sql() -> String {
    format!("WITH target_heads AS MATERIALIZED (SELECT target_key, MIN(order_seq) AS head FROM deliveries WHERE status='Pending' GROUP BY target_key), topic_heads AS (SELECT MIN(h.head) AS head FROM target_heads h LEFT JOIN telegram_bindings b ON b.bot_id=?1 AND substr(h.target_key,1,8)='session:' AND b.session=substr(h.target_key,9) GROUP BY CASE WHEN b.session IS NULL THEN h.target_key ELSE 'telegram:' || b.bot_id || ':' || b.chat || ':' || b.thread END) SELECT {COLUMNS} FROM topic_heads h JOIN deliveries d ON d.order_seq=h.head ORDER BY d.order_seq LIMIT ?2")
}
pub(super) fn dispatch_snapshot(
    db: &Connection,
    bot: i64,
    limit: usize,
) -> Result<DispatchSnapshot, StoreError> {
    if !(0..=MAX_SAFE_INTEGER as i64).contains(&bot) || limit == 0 || limit > MAX_DELIVERY_WINDOW {
        return Err(StoreError::Invalid("invalid dispatch window or bot"));
    }
    let mut bindings = std::collections::BTreeMap::new();
    let mut statement = db.prepare(
        "SELECT chat,thread,session,binding_json FROM telegram_bindings WHERE bot_id=?1",
    )?;
    let mut rows = statement.query([bot])?;
    while let Some(row) = rows.next()? {
        let (topic, session): (crate::telegram::types::TopicKey, crate::domain::SessionId) =
            serde_json::from_str(&row.get::<_, String>(3)?)?;
        if topic.chat.get() != row.get::<_, i64>(0)?
            || topic.thread.map_or(0, |t| t.get()) != row.get::<_, i64>(1)?
            || session.as_str() != row.get::<_, String>(2)?
        {
            return Err(StoreError::Invalid("Telegram binding identity mismatch"));
        }
        bindings.insert(topic, session);
    }
    let mut statement = db.prepare(&dispatch_sql())?;
    let mut rows = statement.query(params![bot, limit as i64])?;
    let mut heads = Vec::new();
    while let Some(row) = rows.next()? {
        heads.push(pending(row)?);
    }
    Ok(DispatchSnapshot { bindings, heads })
}

#[cfg(test)]
fn selected(
    db: &Connection,
    now: SafeInteger,
    limit: usize,
    bindings: Option<BorrowedTopics<'_>>,
) -> Result<Vec<PendingDelivery>, StoreError> {
    if limit == 0 || limit > MAX_DELIVERY_WINDOW {
        return Err(StoreError::Invalid("invalid delivery window"));
    }
    let mut records = Vec::new();
    if let Some((bindings, bot_id)) = bindings {
        let max = MAX_SAFE_INTEGER as i64;
        if !(0..=max).contains(&bot_id) {
            return Err(StoreError::Invalid("invalid delivery bot"));
        }
        let mut sources = std::collections::BTreeSet::new();
        let mut topics = std::collections::BTreeSet::new();
        for (session, chat, thread) in bindings {
            if *chat == 0
                || !(-max..=max).contains(chat)
                || !(0..=max).contains(thread)
                || !sources.insert(session)
                || !topics.insert((chat, thread))
            {
                return Err(StoreError::Invalid("invalid or duplicate delivery binding"));
            }
        }
        // Test-only vector oracle for the retired dynamic-binding API.
        let mut seen = std::collections::BTreeSet::new();
        let mut statement = db.prepare(&format!(
            "SELECT {COLUMNS} FROM deliveries d WHERE d.status='Pending' ORDER BY d.order_seq"
        ))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let record = pending(row)?;
            let effective = match &record.intent.target {
                DeliveryTarget::Session { session, .. } => bindings
                    .iter()
                    .find(|(id, _, _)| id == session)
                    .map(|(_, chat, thread)| format!("telegram:{bot_id}:{chat}:{thread}"))
                    .unwrap_or_else(|| target_key(&record.intent.target)),
                _ => target_key(&record.intent.target),
            };
            if seen.insert(effective) && record.retry_at <= now {
                records.push(record);
                if records.len() == limit {
                    break;
                }
            }
        }
    } else {
        let sql = format!("SELECT {COLUMNS} FROM deliveries d WHERE d.status='Pending' AND d.next_retry<=?1 ORDER BY d.order_seq LIMIT ?2");
        let mut statement = db.prepare(&sql)?;
        let mut rows = statement.query(params![now, limit as i64])?;
        while let Some(row) = rows.next()? {
            records.push(pending(row)?);
        }
    }
    Ok(records)
}
#[cfg(test)]
fn heads(
    db: &Connection,
    now: SafeInteger,
    limit: usize,
) -> Result<Vec<PendingDelivery>, StoreError> {
    if limit == 0 || limit > MAX_DELIVERY_WINDOW {
        return Err(StoreError::Invalid("invalid delivery window"));
    }
    // Apply readiness AFTER the target-head predicate: a deferred earlier row
    // still fences its ready successors. SQL filters backlog before LIMIT, so
    // a single target's arbitrarily long queue cannot fill the read window.
    let sql = format!("SELECT {COLUMNS} FROM deliveries d WHERE d.status='Pending' AND d.next_retry<=?1 AND NOT EXISTS (SELECT 1 FROM deliveries previous WHERE previous.target_key=d.target_key AND previous.status='Pending' AND previous.order_seq<d.order_seq) ORDER BY d.order_seq LIMIT ?2");
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query(params![now, limit as i64])?;
    let mut records = Vec::new();
    while let Some(row) = rows.next()? {
        records.push(pending(row)?);
    }
    Ok(records)
}
pub(super) fn record(
    db: &Connection,
    id: &DeliveryId,
) -> Result<Option<(PendingDelivery, bool)>, StoreError> {
    let sql = format!("SELECT {COLUMNS},d.status FROM deliveries d WHERE d.delivery_id=?1");
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query([id.as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let record = pending(row)?;
    if &record.intent.id != id {
        return Err(StoreError::Invalid("delivery identity mismatch"));
    }
    let is_pending = match row.get::<_, String>(9)?.as_str() {
        "Pending" => true,
        "Acked" => false,
        _ => return Err(StoreError::Invalid("invalid delivery status")),
    };
    Ok(Some((record, is_pending)))
}
fn require(db: &Connection, id: &DeliveryId) -> Result<bool, StoreError> {
    record(db, id)?
        .map(|(_, pending)| pending)
        .ok_or(StoreError::NotFound)
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    match request {
        Request::DispatchSnapshot { bot, limit, reply } => {
            let result = (|| {
                let tx = db.transaction()?;
                let snapshot = dispatch_snapshot(&tx, bot, limit)?;
                tx.commit()?;
                Ok(snapshot)
            })();
            let _ = reply.send(result);
        }
        Request::Enqueue { intent, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = db.transaction()?;
                query::put_delivery(&tx, &intent)?;
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        #[cfg(test)]
        Request::All { now, limit, reply } => {
            let _ = reply.send(selected(db, now, limit, None));
        }
        #[cfg(test)]
        Request::TopicHeads {
            now,
            limit,
            bindings,
            bot_id,
            reply,
        } => {
            let _ = reply.send(selected(db, now, limit, Some((&bindings, bot_id))));
        }
        #[cfg(test)]
        Request::Heads { now, limit, reply } => {
            let _ = reply.send(heads(db, now, limit));
        }
        Request::Ack { id, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = db.transaction()?;
                if require(&tx, &id)? {
                    tx.execute(
                        "UPDATE deliveries SET status='Acked' WHERE delivery_id=?1",
                        [id.as_str()],
                    )?;
                }
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        Request::Fail {
            id,
            failure,
            retry_at,
            reply,
        } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = db.transaction()?;
                if require(&tx, &id)? {
                    let failure = match failure {
                        Failure::Transport => "Transport",
                        Failure::RateLimited => "RateLimited",
                        Failure::InvalidTarget => "InvalidTarget",
                        Failure::PayloadUnavailable => "PayloadUnavailable",
                    };
                    tx.execute("UPDATE deliveries SET attempt=min(attempt+1,4294967295),next_retry=?2,last_failure=?3 WHERE delivery_id=?1", params![id.as_str(), retry_at, failure])?;
                }
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
    }
}
