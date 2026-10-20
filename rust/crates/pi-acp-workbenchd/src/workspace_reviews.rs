//! Captures survive observer cancellation and are completed by the provider
//! lifecycle, not by UI observers. Missing captures after process loss are
//! explicitly unavailable; startup never replays file changes.
use crate::{
    domain::{error::DomainError, SessionId, TurnId},
    persistence::database::Database,
    workspace_gate::WorkspaceLease,
    workspace_review::Snapshot,
};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;
type Captures = HashMap<SessionId, (TurnId, Snapshot, WorkspaceLease)>;
pub(crate) struct Reviews {
    database: Database,
    captures: Mutex<Captures>,
}
impl Reviews {
    pub(crate) fn new(database: Database) -> Arc<Self> {
        Arc::new(Self {
            database,
            captures: Mutex::new(HashMap::new()),
        })
    }
    pub(crate) async fn start(
        &self,
        session: SessionId,
        turn: TurnId,
        snapshot: Snapshot,
        lease: WorkspaceLease,
    ) {
        self.captures
            .lock()
            .await
            .insert(session, (turn, snapshot, lease));
    }
    pub(crate) async fn finish(
        &self,
        session: &SessionId,
        expected: Option<&TurnId>,
    ) -> Result<(), DomainError> {
        let capture = {
            let mut captures = self.captures.lock().await;
            if expected.is_some_and(|turn| {
                captures
                    .get(session)
                    .is_some_and(|(active, _, _)| active != turn)
            }) {
                return Ok(());
            }
            captures.remove(session)
        };
        if let Some((turn, before, _lease)) = capture {
            let root = before.root().to_path_buf();
            let after = tokio::task::spawn_blocking(move || {
                Snapshot::capture(&root).unwrap_or_else(|e| Snapshot::unavailable(root, e))
            })
            .await
            .map_err(|_| DomainError::Persistence("workspace capture task failed".into()))?;
            self.database
                .save_turn_diff(session.clone(), turn, before.diff(&after))
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
        }
        Ok(())
    }
}
