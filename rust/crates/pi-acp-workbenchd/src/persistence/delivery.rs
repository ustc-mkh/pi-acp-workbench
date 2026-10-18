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

pub const MAX_DELIVERY_WINDOW: usize = 1024;
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
type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum Request {
    Enqueue {
        intent: DeliveryIntent,
        reply: Reply<()>,
    },
    Heads {
        now: SafeInteger,
        limit: usize,
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
        if !(0..=max).contains(bot_id)
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
const COLUMNS: &str = "d.delivery_id,d.order_seq,d.target_key,d.target_json,d.payload_json,d.attempt,d.next_retry,d.last_failure";
fn pending(row: &Row<'_>) -> Result<PendingDelivery, StoreError> {
    let id = DeliveryId::new(row.get::<_, String>(0)?)
        .map_err(|_| StoreError::Invalid("invalid delivery identity"))?;
    let order: SafeInteger = row.get(1)?;
    if order.get() == 0 {
        return Err(StoreError::Invalid("invalid delivery order"));
    }
    let intent = DeliveryIntent {
        id,
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
    let is_pending = match row.get::<_, String>(8)?.as_str() {
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
        Request::Enqueue { intent, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = db.transaction()?;
                query::put_delivery(&tx, &intent)?;
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
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
