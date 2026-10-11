//! Snapshot-based undo, never agent-supplied patch execution. All traversal uses
//! non-following directory descriptors; reads are bounded by snapshot size.
//! Each replacement is staged with private permissions and published by rename.
//! Multi-file publication is NOT crash-atomic: the request journal prevents replay.
use crate::types::TurnDiff;
use std::collections::HashSet;
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

const LIMIT: usize = 4 * 1024 * 1024;
fn name(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "文件路径包含 NUL".into())
}
fn io_error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn open_at(parent: &File, child: &str, flags: i32) -> Result<File, String> {
    let child = name(child)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            child.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        Err(io_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
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
            if let Ok(stage) = name(stage) {
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
            let leaf = name(&self.leaf)?;
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    self.parent.as_raw_fd(),
                    leaf.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result == 0 {
                return Err(format!("文件已重新创建：{}", self.path));
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
                return Err(io_error());
            }
            return Ok(());
        }
        let mut file = open_at(&self.parent, &self.leaf, libc::O_RDONLY | libc::O_NONBLOCK)?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.nlink() != 1 || meta.len() != self.after.len() as u64 {
            return Err(format!("文件类型、大小或链接已变化：{}", self.path));
        }
        if self
            .new_mode
            .is_some_and(|mode| meta.mode() & 0o177777 != mode)
        {
            return Err(format!("文件权限已变化：{}", self.path));
        }
        let mut bytes = Vec::with_capacity(self.after.len() + 1);
        (&mut file)
            .take(self.after.len() as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let after = file.metadata().map_err(|e| e.to_string())?;
        if bytes != self.after.as_bytes()
            || meta.mtime_nsec() != after.mtime_nsec()
            || meta.mtime() != after.mtime()
            || meta.ctime() != after.ctime()
            || meta.ctime_nsec() != after.ctime_nsec()
        {
            return Err(format!("文件已有后续修改：{}", self.path));
        }
        Ok(())
    }
    fn stage(&mut self) -> Result<(), String> {
        if self.added {
            return Ok(());
        }
        let stage = format!(".pi-undo-{}", uuid::Uuid::new_v4());
        let mut file = open_at(
            &self.parent,
            &stage,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        self.stage = Some(stage);
        file.write_all(self.before.as_bytes())
            .map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(self.old_mode & 0o777))
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
    fn publish(&mut self) -> Result<(), String> {
        self.verify()?;
        let leaf = name(&self.leaf)?;
        let fd = self.parent.as_raw_fd();
        let result = if self.added {
            unsafe { libc::unlinkat(fd, leaf.as_ptr(), 0) }
        } else {
            let stage = name(self.stage.as_ref().ok_or("撤回临时文件不存在")?)?;
            // Linux is the supported daemon platform. NOREPLACE protects a file
            // recreated between validation and publication of a deleted file.
            unsafe {
                libc::renameat2(
                    fd,
                    stage.as_ptr(),
                    fd,
                    leaf.as_ptr(),
                    if self.deleted {
                        libc::RENAME_NOREPLACE
                    } else {
                        0
                    },
                )
            }
        };
        if result != 0 {
            return Err(io_error());
        }
        self.stage = None;
        self.parent.sync_all().map_err(|e| e.to_string())
    }
}

pub fn undo(cwd: &Path, diff: &TurnDiff, check_only: bool) -> Result<(), String> {
    // First pass has no filesystem mutations, including directory creation.
    if !check_only {
        undo(cwd, diff, true)?;
    }
    if diff.status != "complete" || diff.files.is_empty() || diff.files.len() > 5000 {
        return Err("本轮快照不完整或没有修改，无法安全撤回。".into());
    }
    let root = File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(cwd)
        .map_err(|e| e.to_string())?;
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    // Validate the entire snapshot before creating any directory or temporary file.
    for file in &diff.files {
        let parts: Vec<_> = file.path.split('/').collect();
        if parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == ".." || p.eq_ignore_ascii_case(".git"))
            || file.path.contains(['\\', '\0'])
            || !seen.insert(&file.path)
        {
            return Err(format!("不安全或重复的文件路径：{}", file.path));
        }
        let (Some(before), Some(after)) = (&file.before, &file.after) else {
            return Err("快照未保存完整文本".into());
        };
        bytes = bytes
            .saturating_add(before.len())
            .saturating_add(after.len());
        if bytes > LIMIT
            || before.contains('\0')
            || after.contains('\0')
            || file.omitted.is_some()
            || !matches!(file.status.as_str(), "added" | "modified" | "deleted")
            || (file.status == "added" && !before.is_empty())
            || (file.status == "deleted" && !after.is_empty())
            || [file.old_mode, file.new_mode]
                .into_iter()
                .flatten()
                .any(|m| m & 0o170000 != 0o100000 || m & 0o7000 != 0 || m > 0o177777)
        {
            return Err("快照包含过大、特殊或不一致的文件，无法撤回".into());
        }
    }
    for file in &diff.files {
        let parts: Vec<_> = file.path.split('/').collect();
        // Already validated above; destructure instead of unwrapping.
        let (Some(before), Some(after), Some(leaf)) = (&file.before, &file.after, parts.last())
        else {
            return Err("快照未保存完整文本".into());
        };
        let mut parent = root.try_clone().map_err(|e| e.to_string())?;
        let mut absent = false;
        for part in &parts[..parts.len() - 1] {
            match open_at(&parent, part, libc::O_RDONLY | libc::O_DIRECTORY) {
                Ok(dir) => parent = dir,
                Err(error) => {
                    if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT)
                        || file.status != "deleted"
                    {
                        return Err(error);
                    }
                    if check_only {
                        absent = true;
                        break;
                    }
                    let component = name(part)?;
                    if unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) } != 0
                    {
                        return Err(io_error());
                    }
                    parent.sync_all().map_err(|e| e.to_string())?;
                    parent = open_at(&parent, part, libc::O_RDONLY | libc::O_DIRECTORY)?;
                }
            }
        }
        if absent {
            continue;
        }
        let target = Target {
            parent,
            leaf: leaf.to_string(),
            path: file.path.clone(),
            before: before.clone(),
            after: after.clone(),
            old_mode: file.old_mode.unwrap_or(0o100644) as u32,
            new_mode: file.new_mode.map(|m| m as u32),
            deleted: file.status == "deleted",
            added: file.status == "added",
            stage: None,
        };
        target.verify()?;
        targets.push(target);
    }
    if check_only {
        return Ok(());
    }
    for target in &mut targets {
        target.stage()?;
    }
    for target in &targets {
        target.verify()?;
    }
    for target in &mut targets {
        target.publish().map_err(|error| {
            format!("撤回未完整完成，部分文件可能已恢复；请检查工作区，勿自动重试：{error}")
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot(files: serde_json::Value) -> TurnDiff {
        serde_json::from_value(json!({"status":"complete","warnings":[],"files":files})).unwrap()
    }
    #[test]
    fn restores_private_deleted_file_and_rejects_later_edits_and_links() {
        let root = std::env::temp_dir().join(format!("undo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let diff = snapshot(
            json!([{"path":"private","status":"deleted","added":0,"removed":1,"before":"secret","after":"","oldMode":33152}]),
        );
        undo(&root, &diff, true).unwrap();
        assert!(!root.join("private").exists());
        undo(&root, &diff, false).unwrap();
        assert_eq!(
            std::fs::metadata(root.join("private")).unwrap().mode() & 0o777,
            0o600
        );
        assert!(undo(&root, &diff, false).is_err());
        let modified = snapshot(
            json!([{"path":"private","status":"modified","added":1,"removed":1,"before":"old","after":"secret"}]),
        );
        undo(&root, &modified, false).unwrap();
        assert_eq!(std::fs::read(root.join("private")).unwrap(), b"old");
        assert!(undo(&root, &modified, false).is_err());
        std::os::unix::fs::symlink(root.join("private"), root.join("link")).unwrap();
        let link = snapshot(
            json!([{"path":"link","status":"modified","added":1,"removed":1,"before":"x","after":"old"}]),
        );
        assert!(undo(&root, &link, false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restores_added_deleted_empty_unicode_and_permission_only_files() {
        let root = std::env::temp_dir().join(format!("undo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("新增 \"文件\""), "new").unwrap();
        std::fs::write(root.join("empty"), "").unwrap();
        std::fs::set_permissions(root.join("empty"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        let diff = snapshot(json!([
            {"path":"新增 \"文件\"","status":"added","before":"","after":"new","added":1,"removed":0},
            {"path":"restored/deep/secret","status":"deleted","before":"secret\r\nno newline","after":"","oldMode":33152,"added":0,"removed":1},
            {"path":"empty","status":"modified","before":"","after":"","oldMode":33152,"newMode":33188,"added":0,"removed":0}
        ]));
        undo(&root, &diff, true).unwrap();
        assert!(!root.join("restored").exists());
        undo(&root, &diff, false).unwrap();
        assert!(!root.join("新增 \"文件\"").exists());
        assert_eq!(
            std::fs::read(root.join("restored/deep/secret")).unwrap(),
            b"secret\r\nno newline"
        );
        for path in ["empty", "restored/deep/secret"] {
            assert_eq!(
                std::fs::metadata(root.join(path)).unwrap().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_unsafe_paths_special_modes_and_hard_links() {
        let root = std::env::temp_dir().join(format!("undo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        for path in [
            "../outside",
            "/absolute",
            ".git/config",
            "nested/.GIT/config",
            "a/../b",
            "a\\b",
        ] {
            let diff = snapshot(
                json!([{"path":path,"status":"deleted","before":"old","after":"","added":0,"removed":1}]),
            );
            assert!(undo(&root, &diff, false).is_err(), "{path}");
        }
        std::fs::write(root.join("one"), "after").unwrap();
        std::fs::hard_link(root.join("one"), root.join("two")).unwrap();
        let diff = snapshot(
            json!([{"path":"one","status":"modified","before":"before","after":"after","added":1,"removed":1}]),
        );
        assert!(undo(&root, &diff, false).is_err());
        for mode in [0o120000, 0o104755] {
            let diff = snapshot(
                json!([{"path":"deleted","status":"deleted","before":"before","after":"","oldMode":mode,"added":0,"removed":1}]),
            );
            assert!(undo(&root, &diff, false).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bounds_reads_and_rejects_entire_change_before_publication() {
        let root = std::env::temp_dir().join(format!("undo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("one"), "after").unwrap();
        let huge = File::create(root.join("huge")).unwrap();
        huge.set_len(8 * 1024 * 1024 * 1024).unwrap();
        let diff = snapshot(json!([
            {"path":"one","status":"modified","added":1,"removed":1,"before":"before","after":"after"},
            {"path":"huge","status":"modified","added":1,"removed":1,"before":"before","after":"after"}
        ]));
        assert!(undo(&root, &diff, false).is_err());
        assert_eq!(std::fs::read(root.join("one")).unwrap(), b"after");
        std::fs::remove_dir_all(root).unwrap();
    }
}
