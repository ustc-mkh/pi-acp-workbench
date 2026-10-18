//! Durable operation admission. Started records are never replayed automatically.
use super::io;
use crate::domain::{
    command::DomainCommand, error::DomainError, event::DomainEvent, ids::OperationId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RequestFingerprint(String);
impl RequestFingerprint {
    pub fn of(command: &DomainCommand) -> Result<Self, DomainError> {
        let bytes = serde_json::to_vec(command)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        Ok(Self(format!("{:x}", Sha256::digest(bytes))))
    }
}
impl TryFrom<String> for RequestFingerprint {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid request fingerprint");
        }
        Ok(Self(value))
    }
}
impl From<RequestFingerprint> for String {
    fn from(value: RequestFingerprint) -> Self {
        value.0
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum JournalRecord {
    Started,
    Completed { result: OperationId },
    Failed { result: OperationId },
    Tombstone,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalEntry {
    operation: OperationId,
    fingerprint: RequestFingerprint,
    record: JournalRecord,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationResult {
    operation: OperationId,
    fingerprint: RequestFingerprint,
    result: Result<Vec<DomainEvent>, DomainError>,
}
#[derive(Debug)]
pub struct OperationTicket {
    operation: OperationId,
    fingerprint: RequestFingerprint,
}
pub enum Admission {
    Execute(OperationTicket),
    Replay(Result<Vec<DomainEvent>, DomainError>),
}
#[derive(Clone)]
pub struct JournalStore {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}
impl JournalStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            gate: Arc::new(Mutex::new(())),
        }
    }
    fn entry_path(&self, id: &OperationId) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    fn result_path(&self, id: &OperationId) -> PathBuf {
        self.root.join("results").join(format!("{id}.json"))
    }
    async fn entry(&self, operation: &OperationId) -> Result<Option<JournalEntry>, DomainError> {
        let entry: Option<JournalEntry> = io::read(&self.entry_path(operation)).await?;
        if entry
            .as_ref()
            .is_some_and(|entry| &entry.operation != operation)
        {
            return Err(DomainError::Persistence(
                "journal operation identity mismatch".into(),
            ));
        }
        Ok(entry)
    }
    pub async fn begin(
        &self,
        operation: OperationId,
        command: &DomainCommand,
    ) -> Result<Admission, DomainError> {
        let _gate = self.gate.lock().await;
        let fingerprint = RequestFingerprint::of(command)?;
        let Some(entry) = self.entry(&operation).await? else {
            io::write(
                &self.entry_path(&operation),
                &JournalEntry {
                    operation: operation.clone(),
                    fingerprint: fingerprint.clone(),
                    record: JournalRecord::Started,
                },
            )
            .await?;
            return Ok(Admission::Execute(OperationTicket {
                operation,
                fingerprint,
            }));
        };
        Ok(Admission::Replay(
            self.replay(operation, fingerprint, entry).await?,
        ))
    }
    /// Read-only lookup lets an adapter resume a completed operation before
    /// repeating authorization/preflight steps whose source session was removed.
    pub async fn lookup(
        &self,
        operation: &OperationId,
        command: &DomainCommand,
    ) -> Result<Option<Result<Vec<DomainEvent>, DomainError>>, DomainError> {
        let _gate = self.gate.lock().await;
        let Some(entry) = self.entry(operation).await? else {
            return Ok(None);
        };
        Ok(Some(
            self.replay(operation.clone(), RequestFingerprint::of(command)?, entry)
                .await?,
        ))
    }
    async fn replay(
        &self,
        operation: OperationId,
        fingerprint: RequestFingerprint,
        entry: JournalEntry,
    ) -> Result<Result<Vec<DomainEvent>, DomainError>, DomainError> {
        if entry.fingerprint != fingerprint {
            return Err(DomainError::OperationConflict);
        }
        let expected_success = matches!(entry.record, JournalRecord::Completed { .. });
        match entry.record {
            JournalRecord::Started => Err(DomainError::OperationInterrupted),
            JournalRecord::Tombstone => Err(DomainError::OperationExpired),
            JournalRecord::Completed { result } | JournalRecord::Failed { result } => {
                if result != operation {
                    return Err(DomainError::Persistence(
                        "journal result reference mismatch".into(),
                    ));
                }
                let stored: OperationResult =
                    io::read(&self.result_path(&result)).await?.ok_or_else(|| {
                        DomainError::Persistence("journal result missing; refusing replay".into())
                    })?;
                if stored.operation != operation || stored.fingerprint != fingerprint {
                    return Err(DomainError::Persistence(
                        "journal result identity mismatch".into(),
                    ));
                }
                if stored.result.is_ok() != expected_success {
                    return Err(DomainError::Persistence(
                        "journal terminal outcome mismatch".into(),
                    ));
                }
                Ok(stored.result)
            }
        }
    }
    pub async fn finish(
        &self,
        ticket: OperationTicket,
        result: &Result<Vec<DomainEvent>, DomainError>,
    ) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let entry = self
            .entry(&ticket.operation)
            .await?
            .ok_or_else(|| DomainError::Persistence("journal admission missing".into()))?;
        if entry.fingerprint != ticket.fingerprint
            || !matches!(entry.record, JournalRecord::Started)
        {
            return Err(DomainError::OperationConflict);
        }
        // Persist the immutable result before publishing the terminal receipt.
        io::write(
            &self.result_path(&ticket.operation),
            &OperationResult {
                operation: ticket.operation.clone(),
                fingerprint: ticket.fingerprint.clone(),
                result: result.clone(),
            },
        )
        .await?;
        let record = if result.is_ok() {
            JournalRecord::Completed {
                result: ticket.operation.clone(),
            }
        } else {
            JournalRecord::Failed {
                result: ticket.operation.clone(),
            }
        };
        io::write(
            &self.entry_path(&ticket.operation),
            &JournalEntry {
                operation: ticket.operation,
                fingerprint: ticket.fingerprint,
                record,
            },
        )
        .await
    }
    /// Explicit result GC retains a tombstone, so expired IDs cannot execute again.
    pub async fn expire(&self, operation: &OperationId) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let Some(mut entry) = self.entry(operation).await? else {
            return Ok(());
        };
        if matches!(entry.record, JournalRecord::Started) {
            return Err(DomainError::OperationInterrupted);
        }
        entry.record = JournalRecord::Tombstone;
        io::write(&self.entry_path(operation), &entry).await?;
        io::remove(&self.result_path(operation)).await
    }
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
