//! Durable operation admission on the shared SQLite executor. Started operations
//! are never reexecuted, even when the reply observer or host disappears.
use super::database::{Database, StoreRequest};
use crate::domain::{
    command::DomainCommand, error::DomainError, ids::OperationId, query::CommandReceipt,
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

pub use crate::domain::operation::{OperationTicket, RequestFingerprint};

type OperationResult = Result<CommandReceipt, DomainError>;
type Reply<T> = oneshot::Sender<Result<T, DomainError>>;
pub enum Admission {
    Execute(OperationTicket),
    Replay(OperationResult),
}
/// Queue messages contain typed identities/results, not SQL or executable closures.
pub(super) enum Request {
    CreateLocal {
        ticket: OperationTicket,
        view: Box<crate::domain::query::SessionView>,
        reply: Reply<CommandReceipt>,
    },
    Begin {
        ticket: OperationTicket,
        reply: Reply<Admission>,
    },
    Lookup {
        ticket: OperationTicket,
        reply: Reply<Option<OperationResult>>,
    },
    Finish {
        ticket: OperationTicket,
        result: OperationResult,
        reply: Reply<()>,
    },
    Status {
        operation: OperationId,
        reply: Reply<crate::domain::query::OperationStatus>,
    },
    #[cfg(test)]
    Expire {
        operation: OperationId,
        reply: Reply<()>,
    },
    #[cfg(test)]
    Snapshot {
        reply: Reply<Vec<ArchivedOperation>>,
    },
}
#[derive(Clone)]
pub struct JournalStore {
    database: Database,
}
impl JournalStore {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
    async fn submit(&self, request: Request) -> Result<(), DomainError> {
        self.database
            .enqueue(StoreRequest::Journal(Box::new(request)))
            .await
            .map_err(failure)
    }
    /// Pure local creation: fingerprint admission, session and terminal receipt
    /// have one commit point. No Started row is observable without its result.
    pub async fn create_local(
        &self,
        operation: OperationId,
        harness: crate::domain::Harness,
        cwd: crate::domain::WorkspacePath,
    ) -> Result<CommandReceipt, DomainError> {
        let command = DomainCommand::CreateSession {
            harness: harness.clone(),
            cwd: cwd.clone(),
        };
        let (reply, result) = oneshot::channel();
        self.submit(Request::CreateLocal {
            ticket: OperationTicket {
                operation,
                fingerprint: RequestFingerprint::of(&command)?,
                local: true,
            },
            view: Box::new(crate::domain::query::SessionView::new(harness, cwd)),
            reply,
        })
        .await?;
        result.await.map_err(failure)?
    }
    /// No prepare transaction for operations proven to have no remote effects.
    /// The session lane serializes execution; the writer rechecks identity at
    /// the atomic state/receipt commit point.
    pub async fn admit_local(
        &self,
        operation: OperationId,
        command: &DomainCommand,
    ) -> Result<Admission, DomainError> {
        if let Some(result) = self.lookup(&operation, command).await? {
            return Ok(Admission::Replay(result));
        }
        Ok(Admission::Execute(OperationTicket {
            operation,
            fingerprint: RequestFingerprint::of(command)?,
            local: true,
        }))
    }
    pub async fn begin(
        &self,
        operation: OperationId,
        command: &DomainCommand,
    ) -> Result<Admission, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Begin {
            ticket: OperationTicket {
                operation,
                fingerprint: RequestFingerprint::of(command)?,
                local: false,
            },
            reply,
        })
        .await?;
        result.await.map_err(failure)?
    }
    /// Replay before authorization/preflight steps whose source may be removed.
    pub async fn lookup(
        &self,
        operation: &OperationId,
        command: &DomainCommand,
    ) -> Result<Option<OperationResult>, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Lookup {
            ticket: OperationTicket {
                operation: operation.clone(),
                fingerprint: RequestFingerprint::of(command)?,
                local: false,
            },
            reply,
        })
        .await?;
        result.await.map_err(failure)?
    }
    pub async fn finish(
        &self,
        ticket: OperationTicket,
        outcome: &OperationResult,
    ) -> Result<(), DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Finish {
            ticket,
            result: outcome.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?
    }
    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> Result<Vec<ArchivedOperation>, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Snapshot { reply }).await?;
        result.await.map_err(failure)?
    }
    /// Read-only narrow recovery interface; no command body or provider load.
    pub async fn status(
        &self,
        operation: OperationId,
    ) -> Result<crate::domain::query::OperationStatus, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Status { operation, reply }).await?;
        result.await.map_err(failure)?
    }
    /// Fixture-only expiry exercises tombstone replay; no online receipt GC.
    #[cfg(test)]
    pub(crate) async fn expire(&self, operation: &OperationId) -> Result<(), DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Expire {
            operation: operation.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?
    }
}
fn failure(error: impl std::fmt::Display) -> DomainError {
    DomainError::Persistence(error.to_string())
}

// These functions run only on the one database thread. SQLite serializes all
// independent facades; no facade-local path or file/global mutex is involved.
struct Record {
    fingerprint: RequestFingerprint,
    status: String,
    bytes: Option<Vec<u8>>,
    checksum: Option<String>,
}
fn record(db: &Connection, operation: &OperationId) -> Result<Option<Record>, DomainError> {
    let row = db
        .query_row(
            "SELECT fingerprint,status,result,checksum FROM operations WHERE operation=?1",
            [operation.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(failure)?;
    row.map(|(fingerprint, status, bytes, checksum)| {
        Ok(Record {
            fingerprint: RequestFingerprint::try_from(fingerprint).map_err(failure)?,
            status,
            bytes,
            checksum,
        })
    })
    .transpose()
}
fn replay(ticket: &OperationTicket, record: Record) -> Result<OperationResult, DomainError> {
    if record.fingerprint != ticket.fingerprint {
        return Err(DomainError::OperationConflict);
    }
    match record.status.as_str() {
        "Started" => Err(DomainError::OperationInterrupted),
        "Tombstone" => Err(DomainError::OperationExpired),
        status @ ("Completed" | "Failed") => {
            let bytes = record
                .bytes
                .ok_or_else(|| failure("journal result missing; refusing replay"))?;
            let checksum = format!("{:x}", Sha256::digest(&bytes));
            if record.checksum.as_ref() != Some(&checksum) {
                return Err(failure("journal result checksum mismatch"));
            }
            let result: OperationResult = serde_json::from_slice(&bytes).map_err(failure)?;
            if result.is_ok() != (status == "Completed") {
                return Err(failure("journal terminal outcome mismatch"));
            }
            Ok(result)
        }
        _ => Err(failure("invalid journal status")),
    }
}
fn begin(db: &mut Connection, ticket: OperationTicket) -> Result<Admission, DomainError> {
    let tx = db.transaction().map_err(failure)?;
    if let Some(stored) = record(&tx, &ticket.operation)? {
        return replay(&ticket, stored).map(Admission::Replay);
    }
    tx.execute(
        "INSERT INTO operations(operation,fingerprint,status) VALUES (?1,?2,'Started')",
        params![ticket.operation.as_str(), ticket.fingerprint.0],
    )
    .map_err(failure)?;
    tx.commit().map_err(failure)?;
    Ok(Admission::Execute(ticket))
}
fn finish(
    db: &mut Connection,
    ticket: OperationTicket,
    result: &OperationResult,
) -> Result<(), DomainError> {
    let tx = db.transaction().map_err(failure)?;
    finish_in_transaction(&tx, &ticket, result)?;
    tx.commit().map_err(failure)
}
pub(super) fn finish_in_transaction(
    db: &Connection,
    ticket: &OperationTicket,
    result: &OperationResult,
) -> Result<(), DomainError> {
    // Serialize once: the raw typed result bytes (not a reconstructed receipt or
    // checksummed JSON envelope) are immutable until explicit expiry.
    let bytes = serde_json::to_vec(result).map_err(failure)?;
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    let status = if result.is_ok() {
        "Completed"
    } else {
        "Failed"
    };
    if record(db, &ticket.operation)?.is_none() && ticket.local {
        db.execute(
            "INSERT INTO operations(operation,fingerprint,status) VALUES (?1,?2,'Started')",
            params![ticket.operation.as_str(), ticket.fingerprint.0],
        )
        .map_err(failure)?;
    }
    let current =
        record(db, &ticket.operation)?.ok_or_else(|| failure("journal admission missing"))?;
    if current.fingerprint != ticket.fingerprint || current.status != "Started" {
        return Err(DomainError::OperationConflict);
    }
    let changed = db
        .execute(
            "UPDATE operations SET status=?3,result=?4,checksum=?5 WHERE operation=?1 AND fingerprint=?2 AND status='Started'",
            params![ticket.operation.as_str(), ticket.fingerprint.0, status, bytes, checksum],
        )
        .map_err(failure)?;
    if changed != 1 {
        return Err(DomainError::OperationConflict);
    }
    Ok(())
}
fn create_local(
    db: &mut Connection,
    ticket: OperationTicket,
    view: &crate::domain::query::SessionView,
) -> Result<CommandReceipt, DomainError> {
    view.validate()?;
    let tx = db.transaction().map_err(failure)?;
    if let Some(stored) = record(&tx, &ticket.operation)? {
        return replay(&ticket, stored)?;
    }
    tx.execute(
        "INSERT INTO operations(operation,fingerprint,status) VALUES (?1,?2,'Started')",
        params![ticket.operation.as_str(), ticket.fingerprint.0],
    )
    .map_err(failure)?;
    let created = super::query::insert_view(&tx, view).map_err(failure)?;
    let receipt = CommandReceipt::Created {
        summary: super::query::summary(view, created),
    };
    finish_in_transaction(&tx, &ticket, &Ok(receipt.clone()))?;
    tx.commit().map_err(failure)?;
    Ok(receipt)
}
#[cfg(test)]
fn expire(db: &mut Connection, operation: &OperationId) -> Result<(), DomainError> {
    let tx = db.transaction().map_err(failure)?;
    let Some(current) = record(&tx, operation)? else {
        return Ok(());
    };
    if current.status == "Started" {
        return Err(DomainError::OperationInterrupted);
    }
    tx.execute(
        "UPDATE operations SET status='Tombstone',result=NULL,checksum=NULL WHERE operation=?1",
        [operation.as_str()],
    )
    .map_err(failure)?;
    tx.commit().map_err(failure)
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    // Reply channels observe results; dropping them never cancels accepted work.
    match request {
        Request::CreateLocal {
            ticket,
            view,
            reply,
        } => {
            let _ = reply.send(create_local(db, ticket, &view));
        }
        Request::Status { operation, reply } => {
            use crate::domain::query::OperationStatus as S;
            let result = (|| {
                let Some(stored) = record(db, &operation)? else {
                    return Ok(S::Unknown);
                };
                match stored.status.as_str() {
                    "Started" => Ok(S::Uncertain),
                    "Tombstone" => Ok(S::Expired),
                    _ => {
                        let ticket = OperationTicket {
                            operation,
                            fingerprint: stored.fingerprint.clone(),
                            local: false,
                        };
                        Ok(match replay(&ticket, stored)? {
                            Ok(receipt) => S::Completed { receipt },
                            Err(error) => S::Failed {
                                message: error.to_string(),
                            },
                        })
                    }
                }
            })();
            let _ = reply.send(result);
        }
        Request::Begin { ticket, reply } => {
            let _ = reply.send(begin(db, ticket));
        }
        Request::Lookup { ticket, reply } => {
            let result = record(db, &ticket.operation)
                .and_then(|stored| stored.map(|stored| replay(&ticket, stored)).transpose());
            let _ = reply.send(result);
        }
        Request::Finish {
            ticket,
            result,
            reply,
        } => {
            let _ = reply.send(finish(db, ticket, &result));
        }
        #[cfg(test)]
        Request::Snapshot { reply } => {
            let _ = reply.send(snapshot(db));
        }
        #[cfg(test)]
        Request::Expire { operation, reply } => {
            let _ = reply.send(expire(db, &operation));
        }
    }
}

/// Test-only, exact-row evidence of no operation mutations during queries or
/// delivery. Comparing a missing journal directory would now be vacuous.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ArchivedOperation {
    operation: String,
    fingerprint: String,
    status: String,
    bytes: Option<Vec<u8>>,
    checksum: Option<String>,
}
#[cfg(test)]
fn snapshot(db: &Connection) -> Result<Vec<ArchivedOperation>, DomainError> {
    let mut query = db.prepare("SELECT operation,fingerprint,status,result,checksum FROM operations ORDER BY operation").map_err(failure)?;
    let rows = query
        .query_map([], |row| {
            Ok(ArchivedOperation {
                operation: row.get(0)?,
                fingerprint: row.get(1)?,
                status: row.get(2)?,
                bytes: row.get(3)?,
                checksum: row.get(4)?,
            })
        })
        .map_err(failure)?;
    rows.collect::<Result<_, _>>().map_err(failure)
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
