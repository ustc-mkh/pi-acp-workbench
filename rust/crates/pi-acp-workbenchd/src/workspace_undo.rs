//! Descriptor-relative, snapshot-only undo. Publication is per file, not a
//! filesystem transaction. Durable command admission prevents uncertain replay.
use super::workspace_review::{self as review, DiffStatus, FileStatus, TurnDiff};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::Path,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoReport {
    pub files: Vec<UndoFileResult>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoFileResult {
    pub path: String,
    pub status: String,
    pub error: Option<String>,
}
fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|e| e.to_string())
}
fn io_error() -> String {
    std::io::Error::last_os_error().to_string()
}
struct Target {
    parent: File,
    leaf: String,
    path: String,
    before: String,
    after: String,
    old_mode: u32,
    new_mode: Option<u32>,
    deleted: bool,
    added: bool,
    stage: Option<String>,
}
impl Drop for Target {
    fn drop(&mut self) {
        if let Some(stage) = &self.stage {
            if let Ok(stage) = cstr(stage) {
                unsafe {
                    libc::unlinkat(self.parent.as_raw_fd(), stage.as_ptr(), 0);
                }
            }
        }
    }
}
impl Target {
    fn verify(&self) -> Result<(), String> {
        if self.deleted {
            let leaf = cstr(&self.leaf)?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    self.parent.as_raw_fd(),
                    leaf.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0
            {
                return Err(format!("{}: recreated since turn", self.path));
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
                return Err(io_error());
            }
            return Ok(());
        }
        let mut file = review::open_at(&self.parent, &self.leaf, libc::O_RDONLY | libc::O_NONBLOCK)
            .map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.len() != self.after.len() as u64
            || self.new_mode.is_some_and(|mode| mode != meta.mode())
        {
            return Err(format!(
                "{}: type, links, size or permissions changed",
                self.path
            ));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(self.after.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let after = file.metadata().map_err(|e| e.to_string())?;
        if bytes != self.after.as_bytes()
            || meta.mtime() != after.mtime()
            || meta.mtime_nsec() != after.mtime_nsec()
            || meta.ctime() != after.ctime()
            || meta.ctime_nsec() != after.ctime_nsec()
        {
            return Err(format!("{}: changed since turn", self.path));
        }
        Ok(())
    }
    fn stage(&mut self) -> Result<(), String> {
        if self.added {
            return Ok(());
        }
        let name = format!(".workbench-undo-{}", uuid::Uuid::new_v4());
        let mut file = review::open_at(
            &self.parent,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .map_err(|e| e.to_string())?;
        self.stage = Some(name);
        file.write_all(self.before.as_bytes())
            .map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(self.old_mode & 0o777))
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
    fn publish(&mut self) -> Result<(), String> {
        self.verify()?;
        let leaf = cstr(&self.leaf)?;
        let fd = self.parent.as_raw_fd();
        let result = if self.added {
            unsafe { libc::unlinkat(fd, leaf.as_ptr(), 0) }
        } else {
            let stage = cstr(self.stage.as_ref().ok_or("missing staged file")?)?;
            unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    fd,
                    stage.as_ptr(),
                    fd,
                    leaf.as_ptr(),
                    if self.deleted {
                        libc::RENAME_NOREPLACE
                    } else {
                        0
                    },
                ) as libc::c_int
            }
        };
        if result != 0 {
            return Err(io_error());
        }
        self.stage = None;
        self.parent.sync_all().map_err(|e| e.to_string())
    }
}
pub fn undo(root: &Path, diff: &TurnDiff, check_only: bool) -> Result<UndoReport, String> {
    undo_inner(root, diff, check_only, &mut |_| {})
}
fn undo_inner(
    root: &Path,
    diff: &TurnDiff,
    check_only: bool,
    before_publish: &mut dyn FnMut(usize),
) -> Result<UndoReport, String> {
    if !check_only {
        undo(root, diff, true)?;
    }
    if diff.status != DiffStatus::Complete
        || diff.files.is_empty()
        || diff.files.len() > review::UNDO_FILES_MAX
    {
        return Err("Complete, nonempty workspace snapshot required".into());
    }
    let root = review::open_root(root).map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    let mut path_bytes = 0usize;
    for file in &diff.files {
        if !review::safe_path(&file.path) || !seen.insert(&file.path) {
            return Err(format!("{}: unsafe or duplicate path", file.path));
        }
        let (Some(before), Some(after)) = (&file.before, &file.after) else {
            return Err("Complete text unavailable".into());
        };
        path_bytes = path_bytes.saturating_add(file.path.len());
        if path_bytes > review::UNDO_PATH_BYTES_MAX || file.path.len() > 1024 {
            return Err("Undo path/report budget exceeded".into());
        }
        bytes = bytes
            .saturating_add(before.len())
            .saturating_add(after.len());
        if bytes > review::DETAIL_MAX_BYTES
            || before.len() as u64 > review::FILE_MAX_BYTES
            || after.len() as u64 > review::FILE_MAX_BYTES
            || file.status != FileStatus::Added && file.old_mode.is_none()
            || file.status != FileStatus::Deleted && file.new_mode.is_none()
            || before.contains('\0')
            || after.contains('\0')
            || file.omitted.is_some()
            || file.status == FileStatus::Added
                && (!before.is_empty() || file.before_hash.is_some() || file.old_mode.is_some())
            || file.status == FileStatus::Deleted
                && (!after.is_empty() || file.after_hash.is_some() || file.new_mode.is_some())
            || file.status != FileStatus::Added
                && file.before_hash.as_deref() != Some(review::hash(before.as_bytes()).as_str())
            || file.status != FileStatus::Deleted
                && file.after_hash.as_deref() != Some(review::hash(after.as_bytes()).as_str())
            || [file.old_mode, file.new_mode]
                .into_iter()
                .flatten()
                .any(|m| m & 0o170000 != 0o100000 || m & 0o7000 != 0 || m > 0o177777)
        {
            return Err("Incomplete, oversized, special or inconsistent snapshot".into());
        }
    }
    let mut targets = Vec::new();
    for file in &diff.files {
        let parts: Vec<_> = file.path.split('/').collect();
        let mut parent = root.try_clone().map_err(|e| e.to_string())?;
        let mut absent = false;
        for part in &parts[..parts.len() - 1] {
            match review::open_at(&parent, part, libc::O_RDONLY | libc::O_DIRECTORY) {
                Ok(dir) => parent = dir,
                Err(e) => {
                    if e.raw_os_error() != Some(libc::ENOENT) || file.status != FileStatus::Deleted
                    {
                        return Err(e.to_string());
                    }
                    if check_only {
                        absent = true;
                        break;
                    }
                    let component = cstr(part)?;
                    if unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) } != 0
                    {
                        return Err(io_error());
                    }
                    parent.sync_all().map_err(|e| e.to_string())?;
                    parent = review::open_at(&parent, part, libc::O_RDONLY | libc::O_DIRECTORY)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if absent {
            continue;
        }
        let target = Target {
            parent,
            leaf: parts[parts.len() - 1].into(),
            path: file.path.clone(),
            before: file.before.clone().ok_or("missing before")?,
            after: file.after.clone().ok_or("missing after")?,
            old_mode: file.old_mode.unwrap_or(0o100600),
            new_mode: file.new_mode,
            deleted: file.status == FileStatus::Deleted,
            added: file.status == FileStatus::Added,
            stage: None,
        };
        target.verify()?;
        targets.push(target);
    }
    if check_only {
        return Ok(UndoReport { files: vec![] });
    }
    for target in &mut targets {
        target.stage()?;
    }
    for target in &targets {
        target.verify()?;
    }
    let mut report = UndoReport { files: vec![] };
    let mut failed = false;
    for (index, target) in targets.iter_mut().enumerate() {
        before_publish(index);
        let (status, error) = if failed {
            (
                "not_attempted",
                Some(
                    "Earlier publication failed; inspect workspace. Do not automatically retry."
                        .into(),
                ),
            )
        } else {
            match target.publish() {
                Ok(()) => ("restored", None),
                Err(e) => {
                    failed = true;
                    ("uncertain", Some(e))
                }
            }
        };
        report.files.push(UndoFileResult {
            path: target.path.clone(),
            status: status.into(),
            error,
        });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_review::Snapshot;
    use std::{fs, process::Command};
    fn repo() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("undo-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&p)
            .status()
            .unwrap()
            .success());
        p
    }
    #[test]
    fn refuses_conflict_before_any_restore() {
        let root = repo();
        let a = root.join("a");
        let b = root.join("b");
        fs::write(&a, "old\n").unwrap();
        fs::write(&b, "old b\n").unwrap();
        Command::new("git")
            .args(["add", "a", "b"])
            .current_dir(&root)
            .status()
            .unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(&a, "new\n").unwrap();
        fs::write(&b, "new b\n").unwrap();
        let after = Snapshot::capture(&root).unwrap();
        let diff = before.diff(&after);
        assert!(undo(&root, &diff, true).is_ok());
        fs::write(&b, "external\n").unwrap();
        assert!(undo(&root, &diff, false).is_err());
        assert_eq!(fs::read_to_string(a).unwrap(), "new\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restores_added_deleted_and_permission_changes_and_rejects_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = repo();
        let deleted = root.join("deleted");
        let changed = root.join("mode");
        fs::write(&deleted, "restore me").unwrap();
        fs::write(&changed, "same bytes").unwrap();
        fs::set_permissions(&changed, fs::Permissions::from_mode(0o644)).unwrap();
        Command::new("git")
            .args(["add", "deleted", "mode"])
            .current_dir(&root)
            .status()
            .unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::remove_file(&deleted).unwrap();
        fs::write(root.join("added"), "remove me").unwrap();
        fs::set_permissions(&changed, fs::Permissions::from_mode(0o600)).unwrap();
        let after = Snapshot::capture(&root).unwrap();
        let diff = before.diff(&after);
        let report = undo(&root, &diff, false).unwrap();
        assert_eq!(report.files.len(), 3);
        assert!(report.files.iter().all(|f| f.status == "restored"));
        assert_eq!(fs::read_to_string(&deleted).unwrap(), "restore me");
        assert!(!root.join("added").exists());
        assert_eq!(fs::metadata(changed).unwrap().mode() & 0o777, 0o644);
        let file = root.join("mode");
        fs::write(&file, "after").unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(&file, "later").unwrap();
        let after = Snapshot::capture(&root).unwrap();
        let diff = before.diff(&after);
        let outside = root
            .parent()
            .unwrap()
            .join(format!("undo-outside-{}", uuid::Uuid::new_v4()));
        fs::write(&outside, "outside-safe").unwrap();
        fs::remove_file(&file).unwrap();
        symlink(&outside, &file).unwrap();
        assert!(undo(&root, &diff, false).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside-safe");
        fs::remove_file(&file).unwrap();
        fs::write(&file, "after").unwrap();
        let hard = root.join("hard-link");
        fs::hard_link(&file, &hard).unwrap();
        assert!(undo(&root, &diff, false).is_err());
        fs::remove_file(hard).unwrap();
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publication_conflict_reports_partial_results_without_replaying() {
        let root = repo();
        for name in ["a", "b", "c"] {
            fs::write(root.join(name), "before").unwrap();
        }
        let before = Snapshot::capture(&root).unwrap();
        for name in ["a", "b", "c"] {
            fs::write(root.join(name), "after").unwrap();
        }
        let diff = before.diff(&Snapshot::capture(&root).unwrap());
        let report = undo_inner(&root, &diff, false, &mut |index| {
            if index == 1 {
                fs::write(root.join("b"), "external edit").unwrap();
            }
        })
        .unwrap();
        assert_eq!(
            report
                .files
                .iter()
                .map(|f| f.status.as_str())
                .collect::<Vec<_>>(),
            ["restored", "uncertain", "not_attempted"]
        );
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "before");
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "external edit");
        assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "after");
        assert!(undo(&root, &diff, false).is_err());
        assert!(!fs::read_dir(&root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".workbench-undo-")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_traversal_metadata_paths_and_inconsistent_permissions() {
        let root = repo();
        fs::write(root.join("a"), "before").unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(root.join("a"), "after").unwrap();
        let diff = before.diff(&Snapshot::capture(&root).unwrap());
        for path in [
            "../outside",
            "/absolute",
            ".git/config",
            "dir/../a",
            "dir//a",
            "dir\\a",
        ] {
            let mut invalid = diff.clone();
            invalid.files[0].path = path.into();
            assert!(undo(&root, &invalid, false).is_err(), "{path}");
        }
        let mut invalid = diff.clone();
        invalid.files[0].old_mode = None;
        assert!(undo(&root, &invalid, false).is_err());
        let mut invalid = diff.clone();
        invalid.files[0].new_mode = Some(0o104644);
        assert!(undo(&root, &invalid, false).is_err());
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "after");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restores_deleted_parent_directories_without_following_replacements() {
        use std::os::unix::fs::symlink;
        let root = repo();
        fs::create_dir_all(root.join("sub/deep")).unwrap();
        fs::write(root.join("sub/deep/a"), "before").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&root)
            .status()
            .unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::remove_dir_all(root.join("sub")).unwrap();
        let diff = before.diff(&Snapshot::capture(&root).unwrap());
        symlink("/tmp", root.join("sub")).unwrap();
        assert!(undo(&root, &diff, false).is_err());
        fs::remove_file(root.join("sub")).unwrap();
        assert!(undo(&root, &diff, false)
            .unwrap()
            .files
            .iter()
            .all(|f| f.status == "restored"));
        assert_eq!(
            fs::read_to_string(root.join("sub/deep/a")).unwrap(),
            "before"
        );
        assert_eq!(
            fs::metadata(root.join("sub")).unwrap().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn successful_restore_has_per_file_result() {
        let root = repo();
        let file = root.join("a");
        fs::write(&file, "before").unwrap();
        Command::new("git")
            .args(["add", "a"])
            .current_dir(&root)
            .status()
            .unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(&file, "after").unwrap();
        let after = Snapshot::capture(&root).unwrap();
        let report = undo(&root, &before.diff(&after), false).unwrap();
        assert_eq!(report.files[0].status, "restored");
        assert_eq!(fs::read_to_string(file).unwrap(), "before");
        fs::remove_dir_all(root).unwrap();
    }
}
