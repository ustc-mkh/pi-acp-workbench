//! Session owners submit a single typed transaction; no split image/archive writes.
use super::database::SessionCommit;
use crate::domain::{query::CommitBatch, SessionState};
use std::future::Future;
pub trait SessionPersistence: Clone + Send + Sync + 'static {
    fn load(&self, id: &str) -> impl Future<Output = Result<Option<SessionState>, String>> + Send;
    fn list(&self) -> impl Future<Output = Result<Vec<SessionState>, String>> + Send;
    /// Creation/native adoption uses full state until the actor/fork cutover.
    fn save(&self, state: &SessionState) -> impl Future<Output = Result<(), String>> + Send;
    /// CAS hot state, append entries/images, tools, immutable archives and delivery
    /// intent together. A reply is observable only after the transaction commits.
    fn commit(
        &self,
        change: SessionCommit,
    ) -> impl Future<Output = Result<CommitBatch, String>> + Send;
    fn remove(&self, id: &str) -> impl Future<Output = Result<(), String>> + Send;
}
impl SessionPersistence for super::SessionStore {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        self.load(id).await
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        self.list().await
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.save(state).await
    }
    async fn commit(&self, change: SessionCommit) -> Result<CommitBatch, String> {
        self.commit(change).await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.remove(id).await
    }
}
