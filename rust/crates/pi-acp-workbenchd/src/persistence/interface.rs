//! Session actors depend only on this commit contract, not filesystem details.
use crate::domain::{event::DomainEvent, SessionState};
use std::future::Future;
pub trait SessionPersistence: Clone + Send + Sync + 'static {
    fn load(&self, id: &str) -> impl Future<Output = Result<Option<SessionState>, String>> + Send;
    fn list(&self) -> impl Future<Output = Result<Vec<SessionState>, String>> + Send;
    fn save(&self, state: &SessionState) -> impl Future<Output = Result<(), String>> + Send;
    /// State and delivery intent must be durable together before returning Ok.
    fn commit(
        &self,
        state: &SessionState,
        events: &[DomainEvent],
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Archive before committing any reference. Default fails closed for stores
    /// that have not explicitly implemented binary payload persistence.
    fn save_image(
        &self,
        _asset: &crate::domain::image::ImageAsset,
    ) -> impl Future<Output = Result<(), String>> + Send {
        async { Err("image persistence is unavailable".into()) }
    }
    fn remove(&self, id: &str) -> impl Future<Output = Result<(), String>> + Send;
}
impl SessionPersistence for super::HistoryStore {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        self.load(id).await
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        self.list().await
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.save(state).await
    }
    async fn commit(&self, state: &SessionState, events: &[DomainEvent]) -> Result<(), String> {
        self.commit(state, events).await
    }
    async fn save_image(&self, asset: &crate::domain::image::ImageAsset) -> Result<(), String> {
        self.payloads
            .put_image(asset)
            .await
            .map_err(|error| error.to_string())
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.remove(id).await
    }
}
