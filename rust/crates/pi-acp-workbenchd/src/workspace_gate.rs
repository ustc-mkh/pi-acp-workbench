//! Workspace permits cover provider lifetime, including autonomous/idle workers.
//! Shared permits do not serialize normal turns; exclusive permits exclude only
//! identical or nested canonical workspaces. External processes are not locked.
use crate::domain::error::DomainError;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Default)]
pub(crate) struct WorkspaceGate(Arc<Mutex<Vec<(PathBuf, bool, uuid::Uuid)>>>);
pub(crate) struct WorkspaceLease {
    active: Arc<Mutex<Vec<(PathBuf, bool, uuid::Uuid)>>>,
    id: uuid::Uuid,
}
impl WorkspaceGate {
    pub(super) fn enter(
        &self,
        root: PathBuf,
        exclusive: bool,
    ) -> Result<WorkspaceLease, DomainError> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if active.iter().any(|(path, writer, _)| {
            (exclusive || *writer) && (root.starts_with(path) || path.starts_with(&root))
        }) {
            return Err(DomainError::Busy);
        }
        let id = uuid::Uuid::new_v4();
        active.push((root, exclusive, id));
        Ok(WorkspaceLease {
            active: self.0.clone(),
            id,
        })
    }
}
impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(_, _, id)| *id != self.id);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_workspaces_exclude_undo_without_serializing_turns() {
        let gate = WorkspaceGate::default();
        let a = gate.enter("/work/a".into(), false).unwrap();
        let b = gate.enter("/work/a/sub".into(), false).unwrap();
        assert!(gate.enter("/work".into(), true).is_err());
        assert!(gate.enter("/work/a".into(), true).is_err());
        assert!(gate.enter("/work/b".into(), true).is_ok());
        drop(a);
        drop(b);
        let undo = gate.enter("/work/a".into(), true).unwrap();
        assert!(gate.enter("/work/a/sub".into(), false).is_err());
        assert!(gate.enter("/work/b".into(), false).is_ok());
        drop(undo);
    }
}
