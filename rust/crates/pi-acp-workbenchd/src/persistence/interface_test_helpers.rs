//! Test spies keep real bounded SQL queries while overriding selected failures.
macro_rules! delegate_session_aux {
    () => {
        async fn tool(
            &self,
            session: &crate::domain::SessionId,
            turn: &crate::domain::TurnId,
            tool: &crate::domain::ToolCallId,
        ) -> Result<Option<crate::domain::query::ToolHeader>, String> {
            crate::persistence::interface::SessionPersistence::tool(
                &self.history,
                session,
                turn,
                tool,
            )
            .await
        }
        async fn prepare_fork(
            &self,
            view: &crate::domain::query::SessionView,
            request: crate::domain::fork::ForkRequest,
            candidates: Vec<crate::domain::fork::ForkCandidate>,
        ) -> Result<crate::domain::fork::ForkPlan, String> {
            crate::persistence::interface::SessionPersistence::prepare_fork(
                &self.history,
                view,
                request,
                candidates,
            )
            .await
        }
        async fn adopt_fork(
            &self,
            plan: crate::domain::fork::ForkPlan,
            native: crate::domain::ProviderSessionId,
        ) -> Result<
            (
                crate::domain::query::SessionView,
                crate::domain::query::SessionSummary,
            ),
            String,
        > {
            crate::persistence::interface::SessionPersistence::adopt_fork(
                &self.history,
                plan,
                native,
            )
            .await
        }
    };
}
macro_rules! delegate_session_queries {
    () => {
        crate::persistence::interface_test_helpers::delegate_session_aux!();
        async fn load(
            &self,
            id: &crate::domain::SessionId,
        ) -> Result<Option<crate::domain::query::SessionView>, String> {
            crate::persistence::interface::SessionPersistence::load(&self.history, id).await
        }
        async fn list(
            &self,
            cursor: Option<crate::domain::query::ListCursor>,
            limit: Option<usize>,
        ) -> Result<crate::domain::query::ListPage, String> {
            crate::persistence::interface::SessionPersistence::list(&self.history, cursor, limit)
                .await
        }
        async fn create(
            &self,
            view: &crate::domain::query::SessionView,
        ) -> Result<crate::domain::query::SessionSummary, String> {
            crate::persistence::interface::SessionPersistence::create(&self.history, view).await
        }
        async fn remove(
            &self,
            id: &crate::domain::SessionId,
            operation: Option<crate::domain::operation::OperationTicket>,
        ) -> Result<crate::domain::query::CommitBatch, String> {
            crate::persistence::interface::SessionPersistence::remove(&self.history, id, operation)
                .await
        }
    };
}
pub(crate) use {delegate_session_aux, delegate_session_queries};
