//! Legacy actor-contract adapter backed exclusively by the shared SQLite store.
//! Full transcript reconstruction is transitional and removed by T05.
use super::{
    database::{Database, SessionCommit},
    outbox::OutboxStore,
    payload::PayloadStore,
};
use crate::domain::{query::CommitBatch, SessionId, SessionState};
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
    pub async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        let id = SessionId::new(id).map_err(|error| error.to_string())?;
        self.database
            .load_state(id)
            .await
            .map_err(|error| error.to_string())
    }
    pub async fn list(&self) -> Result<Vec<SessionState>, String> {
        self.database
            .list_states()
            .await
            .map_err(|error| error.to_string())
    }
    pub async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.database
            .save_state(state.clone())
            .await
            .map_err(|error| error.to_string())
    }
    pub async fn commit(&self, change: SessionCommit) -> Result<CommitBatch, String> {
        self.database
            .commit(change)
            .await
            .map_err(|error| error.to_string())
    }
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let id = SessionId::new(id).map_err(|error| error.to_string())?;
        self.database
            .remove_state(id)
            .await
            .map_err(|error| error.to_string())
    }
    pub fn database(&self) -> &Database {
        &self.database
    }
}
