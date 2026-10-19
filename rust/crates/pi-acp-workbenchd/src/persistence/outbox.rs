//! At-least-once delivery facade; no independent files, locks or executor.
pub use super::delivery::Failure as DeliveryFailure;
use super::{
    database::{Database, StoreError},
    delivery::{Failure, MAX_DELIVERY_WINDOW},
};
#[cfg(test)]
use crate::domain::query::MAX_SAFE_INTEGER;
pub use crate::domain::transition::{
    DeliveryIntent as DeliveryEvent, DeliveryPayload, DeliveryTarget,
};
use crate::domain::{error::DomainError, query::SafeInteger, DeliveryId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DeliveryStatus {
    Pending,
    Delivered,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryRecord {
    pub event: DeliveryEvent,
    pub sequence: u64,
    pub status: DeliveryStatus,
    pub attempt: u32,
    pub retry_at: u64,
    pub last_failure: Option<DeliveryFailure>,
}
#[derive(Clone)]
pub struct OutboxStore {
    database: Database,
    window: usize,
}
impl OutboxStore {
    pub fn new(database: Database, window: usize) -> Self {
        Self {
            database,
            window: window.clamp(1, MAX_DELIVERY_WINDOW),
        }
    }
    #[cfg(test)]
    pub(crate) async fn pause_mutations(&self) -> super::sqlite_tests::ExecutorPause {
        self.database.pause_executor().await.unwrap()
    }
    pub fn capacity(&self) -> usize {
        self.window
    }
    pub async fn enqueue(&self, event: DeliveryEvent) -> Result<(), DomainError> {
        self.database.enqueue_delivery(event).await.map_err(failure)
    }
    #[cfg(test)]
    pub async fn pending(
        &self,
        now: u64,
        limit: usize,
    ) -> Result<Vec<DeliveryRecord>, DomainError> {
        if limit == 0 {
            return Ok(vec![]);
        }
        // u64::MAX is the existing internal 'include deferred heads' sentinel,
        // not a persisted integer. Every SQL bound remains exactly JS-safe.
        let now = SafeInteger::new(if now == u64::MAX {
            MAX_SAFE_INTEGER
        } else {
            now
        })
        .map_err(|e| DomainError::Persistence(e.to_string()))?;
        let rows = self
            .database
            .pending_delivery_records(now, limit.min(self.window))
            .await
            .map_err(failure)?;
        Ok(rows
            .into_iter()
            .map(|row| DeliveryRecord {
                event: row.intent,
                sequence: row.order.get(),
                status: DeliveryStatus::Pending,
                attempt: row.attempt,
                retry_at: row.retry_at.get(),
                last_failure: row.last_failure,
            })
            .collect())
    }
    pub async fn fail(
        &self,
        id: &DeliveryId,
        reason: Failure,
        retry_at: u64,
    ) -> Result<(), DomainError> {
        let retry_at =
            SafeInteger::new(retry_at).map_err(|e| DomainError::Persistence(e.to_string()))?;
        self.database
            .fail_delivery(id.clone(), reason, retry_at)
            .await
            .map_err(failure)
    }
    pub async fn ack(&self, id: &DeliveryId) -> Result<(), DomainError> {
        self.database
            .ack_delivery(id.clone())
            .await
            .map_err(failure)
    }
}
fn failure(error: StoreError) -> DomainError {
    match error {
        StoreError::Conflict => DomainError::OperationConflict,
        other => DomainError::Persistence(other.to_string()),
    }
}
#[cfg(test)]
#[path = "outbox_tests.rs"]
mod tests;
