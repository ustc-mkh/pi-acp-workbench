//! Session owners submit bounded hot-state reads and one incremental transaction.
use crate::domain::{
    fork::{ForkCandidate, ForkPlan, ForkRequest},
    query::{CommitBatch, ListCursor, ListPage, SessionSummary, SessionView, ToolHeader},
    transition::Transition,
    ProviderSessionId, SessionId, ToolCallId, TurnId,
};
use std::future::Future;
pub trait SessionPersistence: Clone + Send + Sync + 'static {
    fn load(
        &self,
        id: &SessionId,
    ) -> impl Future<Output = Result<Option<SessionView>, String>> + Send;
    fn list(
        &self,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> impl Future<Output = Result<ListPage, String>> + Send;
    fn create(
        &self,
        view: &SessionView,
    ) -> impl Future<Output = Result<SessionSummary, String>> + Send;
    fn tool(
        &self,
        session: &SessionId,
        turn: &TurnId,
        tool: &ToolCallId,
    ) -> impl Future<Output = Result<Option<ToolHeader>, String>> + Send;
    fn prepare_fork(
        &self,
        view: &SessionView,
        request: ForkRequest,
        candidates: Vec<ForkCandidate>,
    ) -> impl Future<Output = Result<ForkPlan, String>> + Send;
    fn adopt_fork(
        &self,
        plan: ForkPlan,
        native: ProviderSessionId,
    ) -> impl Future<Output = Result<(SessionView, SessionSummary), String>> + Send;
    /// CAS hot state, entries/images, tools, immutable archives and delivery
    /// intents together. A reply is observable only after transaction commit.
    fn commit(
        &self,
        change: Transition,
    ) -> impl Future<Output = Result<CommitBatch, String>> + Send;
    fn remove(
        &self,
        id: &SessionId,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> impl Future<Output = Result<CommitBatch, String>> + Send;
}
impl SessionPersistence for super::SessionStore {
    async fn load(&self, id: &SessionId) -> Result<Option<SessionView>, String> {
        match self.database().view(id.clone()).await {
            Ok(view) => Ok(Some(view)),
            Err(super::database::StoreError::NotFound) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    async fn list(
        &self,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> Result<ListPage, String> {
        self.database()
            .list(cursor, limit)
            .await
            .map_err(|error| error.to_string())
    }
    async fn create(&self, view: &SessionView) -> Result<SessionSummary, String> {
        self.database()
            .create(view.clone())
            .await
            .map_err(|error| error.to_string())
    }
    async fn tool(
        &self,
        session: &SessionId,
        turn: &TurnId,
        tool: &ToolCallId,
    ) -> Result<Option<ToolHeader>, String> {
        self.database()
            .tool(session.clone(), turn.clone(), tool.clone())
            .await
            .map_err(|error| error.to_string())
    }
    async fn prepare_fork(
        &self,
        view: &SessionView,
        request: ForkRequest,
        candidates: Vec<ForkCandidate>,
    ) -> Result<ForkPlan, String> {
        self.database()
            .prepare_fork(view.clone(), request, candidates)
            .await
            .map_err(|error| error.to_string())
    }
    async fn adopt_fork(
        &self,
        plan: ForkPlan,
        native: ProviderSessionId,
    ) -> Result<(SessionView, SessionSummary), String> {
        self.database()
            .adopt_fork(plan, native)
            .await
            .map_err(|error| error.to_string())
    }
    async fn commit(&self, change: Transition) -> Result<CommitBatch, String> {
        self.database()
            .commit(change)
            .await
            .map_err(|error| error.to_string())
    }
    async fn remove(
        &self,
        id: &SessionId,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<CommitBatch, String> {
        self.database()
            .remove(id.clone(), operation)
            .await
            .map_err(|error| error.to_string())
    }
}
