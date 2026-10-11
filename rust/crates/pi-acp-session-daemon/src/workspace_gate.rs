//! Shared permits preserve concurrent agent sessions; undo takes an exclusive
//! permit across identical/nested workspaces. External editors are not locked.
use pi_acp_core::sync::MutexExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

type Active = Arc<Mutex<Vec<(PathBuf, bool, uuid::Uuid)>>>;
#[derive(Default)]
pub struct WorkspaceGate(Active);
pub struct WorkspacePermit {
    active: Active,
    id: uuid::Uuid,
}
impl WorkspaceGate {
    pub async fn enter(&self, cwd: &str, exclusive: bool) -> Result<WorkspacePermit, String> {
        if !Path::new(cwd).is_absolute() {
            return Err("工作区需要绝对目录路径".into());
        }
        let root = tokio::fs::canonicalize(cwd)
            .await
            .map_err(|_| "工作区不是目录".to_string())?;
        if !root.is_dir() {
            return Err("工作区不是目录".into());
        }
        self.acquire(root, exclusive)
    }
    fn acquire(&self, root: PathBuf, exclusive: bool) -> Result<WorkspacePermit, String> {
        let mut active = self.0.lock_unpoisoned();
        if active
            .iter()
            .any(|(other, writer, _)| (exclusive || *writer) && overlaps(other, &root))
        {
            return Err("工作目录正在被其他任务使用，请等待任务结束后重试。".into());
        }
        let id = uuid::Uuid::new_v4();
        active.push((root, exclusive, id));
        Ok(WorkspacePermit {
            active: self.0.clone(),
            id,
        })
    }
}
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
impl Drop for WorkspacePermit {
    fn drop(&mut self) {
        self.active
            .lock_unpoisoned()
            .retain(|(_, _, id)| *id != self.id);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn undo_excludes_same_and_nested_workspaces_but_turns_can_coexist() {
        let gate = WorkspaceGate::default();
        let first = gate.acquire("/work/project".into(), false).unwrap();
        let second = gate.acquire("/work/project".into(), false).unwrap();
        for path in ["/work", "/work/project", "/work/project/sub"] {
            assert!(gate.acquire(path.into(), true).is_err());
        }
        assert!(gate.acquire("/work/other".into(), true).is_ok());
        drop(first);
        assert!(gate.acquire("/work/project".into(), true).is_err());
        drop(second);
        let undo = gate.acquire("/work/project".into(), true).unwrap();
        assert!(gate.acquire("/work/project/sub".into(), false).is_err());
        drop(undo);
        assert!(gate.acquire("/work/project".into(), false).is_ok());
    }
}
