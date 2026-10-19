//! Session facade for the shared incremental SQLite store.
use super::{database::Database, outbox::OutboxStore, payload::PayloadStore};
use crate::domain::query::CommitBatch;
#[cfg(test)]
use std::path::PathBuf;

#[derive(Clone)]
pub struct SessionStore {
    database: Database,
    pub outbox: OutboxStore,
    pub payloads: PayloadStore,
}
impl SessionStore {
    pub fn new(database: Database) -> Self {
        Self {
            database: database.clone(),
            outbox: OutboxStore::new(database.clone(), 1024),
            payloads: PayloadStore::new(database),
        }
    }
    /// Isolated SQL fixture. The root contains only SQLite and lease metadata.
    #[cfg(test)]
    pub(crate) fn fixture(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let lease = super::format::StorageLease::lock(&root).unwrap();
        let database = Database::open_sync(&root, &lease).unwrap();
        Self::new(database)
    }
    pub async fn commit(
        &self,
        change: crate::domain::transition::Transition,
    ) -> Result<CommitBatch, String> {
        self.database
            .commit(change)
            .await
            .map_err(|error| error.to_string())
    }
    pub fn database(&self) -> &Database {
        &self.database
    }
}
