//! At-least-once delivery records. Retry never invokes a domain/agent command.
use super::io;
use crate::domain::{
    error::DomainError,
    ids::{DeliveryId, EntryId, ImageId, InteractionId, NoticeId, SessionId, TurnId},
    WorkspacePath,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::{fs, sync::Mutex};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeliveryTarget {
    Session {
        session: SessionId,
        cwd: WorkspacePath,
    },
    Telegram(crate::telegram::types::TopicKey),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeliveryPayload {
    SessionCompleted { turn: TurnId, entries: Vec<EntryId> },
    AgentMessage { entry: EntryId },
    Interaction { interaction: InteractionId },
    Image { image: ImageId },
    Notice { notice: NoticeId },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryEvent {
    pub id: DeliveryId,
    pub revision: u64,
    pub target: DeliveryTarget,
    pub payload: DeliveryPayload,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeliveryStatus {
    Pending,
    Delivered,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeliveryFailure {
    Transport,
    RateLimited,
    InvalidTarget,
    PayloadUnavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryRecord {
    format_version: u32,
    pub event: DeliveryEvent,
    /// Durable outbox admission order; domain revisions from different
    /// sessions/Telegram commands are NOT a common clock. Ack tombstones retain
    /// the high-water mark; future GC must preserve it before removing them.
    pub sequence: u64,
    pub status: DeliveryStatus,
    pub attempt: u32,
    pub retry_at: u64,
    pub last_failure: Option<DeliveryFailure>,
}
#[derive(Clone)]
pub struct OutboxStore {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
    max_pending: usize,
}
impl OutboxStore {
    pub fn new(root: impl Into<PathBuf>, max_pending: usize) -> Self {
        Self {
            root: root.into(),
            gate: Arc::new(Mutex::new(())),
            max_pending,
        }
    }
    #[cfg(test)]
    pub(crate) async fn pause_mutations(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.gate.clone().lock_owned().await
    }
    pub fn capacity(&self) -> usize {
        self.max_pending
    }
    fn path(&self, id: &DeliveryId) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    async fn records(&self) -> Result<Vec<DeliveryRecord>, DomainError> {
        let mut directory = match fs::read_dir(&self.root).await {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(DomainError::Persistence(error.to_string())),
        };
        let mut records = vec![];
        while let Some(entry) = directory
            .next_entry()
            .await
            .map_err(|error| DomainError::Persistence(error.to_string()))?
        {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let id = DeliveryId::new(
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| DomainError::Persistence("invalid outbox filename".into()))?,
            )?;
            let record: DeliveryRecord = io::read(&path)
                .await?
                .ok_or_else(|| DomainError::Persistence("outbox record vanished".into()))?;
            if record.format_version != 2 {
                return Err(DomainError::Persistence(
                    "unsupported outbox record format".into(),
                ));
            }
            if record.event.id != id {
                return Err(DomainError::Persistence(
                    "outbox event identity mismatch".into(),
                ));
            }
            records.push(record);
        }
        let mut sequences = std::collections::BTreeSet::new();
        for record in &records {
            if record.sequence == 0 || !sequences.insert(record.sequence) {
                return Err(DomainError::Persistence(
                    "invalid or duplicate outbox sequence".into(),
                ));
            }
        }
        records.sort_by_key(|record| record.sequence);
        Ok(records)
    }
    async fn load(&self, id: &DeliveryId) -> Result<Option<DeliveryRecord>, DomainError> {
        let record: Option<DeliveryRecord> = io::read(&self.path(id)).await?;
        if record.as_ref().is_some_and(|record| {
            record.format_version != 2 || &record.event.id != id || record.sequence == 0
        }) {
            return Err(DomainError::Persistence(
                "outbox event identity mismatch".into(),
            ));
        }
        Ok(record)
    }
    pub async fn enqueue(&self, event: DeliveryEvent) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        if let Some(existing) = self.load(&event.id).await? {
            if existing.event != event {
                return Err(DomainError::OperationConflict);
            }
            return Ok(()); // Includes acknowledged tombstones: never redeliver them.
        }
        let records = self.records().await?;
        let sequence = records
            .last()
            .map_or(Some(1), |record| record.sequence.checked_add(1))
            .ok_or_else(|| DomainError::Persistence("outbox sequence exhausted".into()))?;
        if records
            .iter()
            .filter(|record| record.status == DeliveryStatus::Pending)
            .count()
            >= self.max_pending
        {
            return Err(DomainError::Backpressure);
        }
        io::write(
            &self.path(&event.id),
            &DeliveryRecord {
                format_version: 2,
                event: event.clone(),
                sequence,
                status: DeliveryStatus::Pending,
                attempt: 0,
                retry_at: 0,
                last_failure: None,
            },
        )
        .await
    }
    pub async fn pending(
        &self,
        now: u64,
        limit: usize,
    ) -> Result<Vec<DeliveryRecord>, DomainError> {
        let _gate = self.gate.lock().await;
        Ok(self
            .records()
            .await?
            .into_iter()
            .filter(|record| record.status == DeliveryStatus::Pending && record.retry_at <= now)
            .take(limit)
            .collect())
    }
    pub async fn fail(
        &self,
        id: &DeliveryId,
        failure: DeliveryFailure,
        retry_at: u64,
    ) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut record = self
            .load(id)
            .await?
            .ok_or_else(|| DomainError::Persistence("outbox event missing".into()))?;
        if record.status == DeliveryStatus::Delivered {
            return Ok(());
        }
        record.attempt = record.attempt.saturating_add(1);
        record.last_failure = Some(failure);
        record.retry_at = retry_at;
        io::write(&self.path(id), &record).await
    }
    pub async fn ack(&self, id: &DeliveryId) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut record = self
            .load(id)
            .await?
            .ok_or_else(|| DomainError::Persistence("outbox event missing".into()))?;
        if record.status == DeliveryStatus::Delivered {
            return Ok(());
        }
        record.status = DeliveryStatus::Delivered;
        io::write(&self.path(id), &record).await
    }
}

#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;
