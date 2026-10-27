//! Workspace undo orchestration; filesystem work never executes on the async runtime.
use super::*;

impl CommandCore {
    pub(super) async fn undo_turn(
        &self,
        session: &SessionId,
        turn: &crate::domain::TurnId,
        files: &Option<Vec<String>>,
    ) -> Result<CommandReceipt, DomainError> {
        let view = self
            .database
            .view(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        let diff = self
            .database
            .turn_diff(session.clone(), turn.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?
            .ok_or_else(|| DomainError::NotFound(session.clone()))?;
        let files = files.clone();
        // Validate selection before stopping a provider.
        crate::workspace_undo::select_files(diff.clone(), files.as_deref())
            .map_err(DomainError::Persistence)?;
        let root = crate::workspace_review::canonical(std::path::Path::new(view.cwd.as_str()))
            .map_err(DomainError::Persistence)?;
        if view.active_turn.is_some() {
            return Err(DomainError::Busy);
        }
        // Idle providers may still produce background writes. Join this
        // session's provider before acquiring the exclusive workspace permit;
        // other overlapping providers keep their permits and cause Busy.
        self.stop_session_adapter(session).await?;
        let _undo_lease = self.workspace_gate.enter(root.clone(), true)?;
        let report = tokio::task::spawn_blocking(move || {
            crate::workspace_undo::undo_selected(&root, diff, files.as_deref(), false)
        })
        .await
        .map_err(|_| DomainError::Persistence("undo task interrupted".into()))?
        .map_err(DomainError::Persistence)?;
        Ok(CommandReceipt::UndoCompleted {
            session: session.clone(),
            report,
        })
    }
}
