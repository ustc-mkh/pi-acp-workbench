//! Bounded workspace net changes, not provider-supplied tool patches.
//! Git-ignored files are outside scope. Concurrent manual/other-session edits
//! can be included. Partial snapshots are never undo points.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub const FILES_MAX: usize = 5000;
pub const FILE_MAX_BYTES: u64 = 1024 * 1024;
pub const SNAPSHOT_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const DETAIL_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const UNDO_FILES_MAX: usize = 256;
pub const UNDO_PATH_BYTES_MAX: usize = 64 * 1024;
const ENUM_MAX_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnDiff {
    pub status: DiffStatus,
    pub files: Vec<FileDiff>,
    pub warnings: Vec<String>,
    pub added: u64,
    pub removed: u64,
    #[serde(default)]
    pub next_offset: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    Complete,
    Partial,
    Unavailable,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatus,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub added: u64,
    pub removed: u64,
    pub patch: Option<String>,
    pub omitted: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
}
#[derive(Clone, Debug)]
struct State {
    text: Option<String>,
    mode: u32,
    hash: String,
}
#[derive(Debug)]
pub struct Snapshot {
    root: PathBuf,
    files: BTreeMap<String, State>,
    warnings: Vec<String>,
    complete: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiffContent {
    pub bytes: String,
    pub total_bytes: usize,
    pub next_offset: Option<usize>,
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.eq_ignore_ascii_case(".git"))
}
fn git_files(root: &Path) -> Result<Vec<String>, String> {
    use std::os::unix::process::CommandExt;
    let mut child = Command::new("git")
        .args([
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .env_clear()
        .envs(std::env::vars_os().filter(|(k, _)| !k.to_string_lossy().starts_with("GIT_")))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut pipe = child.stdout.take().ok_or("enumeration pipe unavailable")?;
    unsafe {
        libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
    }
    let start = Instant::now();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 8192];
    let result = (|| {
        loop {
            if start.elapsed() > Duration::from_secs(10) {
                return Err("Git enumeration timed out".to_owned());
            }
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if bytes.len() + n > ENUM_MAX_BYTES {
                        return Err("Git enumeration exceeded budget".into());
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(s) if s.success() => break,
                Some(_) => {
                    return Err(
                        "Git inventory unavailable; workspace must be a Git worktree".into(),
                    )
                }
                None => {
                    if start.elapsed() > Duration::from_secs(10) {
                        return Err("Git enumeration timed out".into());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        let mut names = Vec::new();
        for raw in bytes.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            let n = std::str::from_utf8(raw).map_err(|_| "non-UTF8 inventory path")?;
            if !safe_path(n) {
                return Err("unsafe inventory path".into());
            }
            names.push(n.to_owned());
            if names.len() > FILES_MAX {
                return Err("file inventory exceeds 5000 paths".into());
            }
        }
        names.sort();
        names.dedup();
        Ok(names)
    })();
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    result
}
pub(super) fn open_at(parent: &fs::File, name: &str, flags: i32) -> std::io::Result<fs::File> {
    let n = std::ffi::CString::new(name).map_err(std::io::Error::other)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            n.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}
pub(super) fn open_root(root: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
}
fn read_state(root: &fs::File, name: &str) -> std::io::Result<Option<State>> {
    let parts: Vec<_> = name.split('/').collect();
    let mut dir = root.try_clone()?;
    for p in &parts[..parts.len() - 1] {
        match open_at(&dir, p, libc::O_RDONLY | libc::O_DIRECTORY) {
            Ok(d) => dir = d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    let mut f = match open_at(
        &dir,
        parts[parts.len() - 1],
        libc::O_RDONLY | libc::O_NONBLOCK,
    ) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let m = f.metadata()?;
    if !m.is_file() || m.mode() & 0o7000 != 0 {
        return Err(std::io::Error::other("special file omitted"));
    }
    if m.len() > FILE_MAX_BYTES {
        return Ok(Some(State {
            text: None,
            mode: m.mode(),
            hash: format!("oversize:{}:{}:{}", m.len(), m.mtime(), m.mtime_nsec()),
        }));
    }
    let mut b = Vec::new();
    (&mut f).take(FILE_MAX_BYTES + 1).read_to_end(&mut b)?;
    let n = f.metadata()?;
    if b.len() as u64 > FILE_MAX_BYTES
        || m.len() != n.len()
        || m.mtime() != n.mtime()
        || m.mtime_nsec() != n.mtime_nsec()
        || m.ctime() != n.ctime()
        || m.ctime_nsec() != n.ctime_nsec()
    {
        return Err(std::io::Error::other("changed during capture"));
    }
    let h = hash(&b);
    let text = if b.contains(&0) {
        None
    } else {
        String::from_utf8(b).ok()
    };
    Ok(Some(State {
        text,
        mode: m.mode(),
        hash: h,
    }))
}
impl Snapshot {
    pub fn unavailable(root: PathBuf, warning: String) -> Self {
        Self {
            root,
            files: BTreeMap::new(),
            warnings: vec![warning],
            complete: false,
        }
    }
    pub fn capture(root: &Path) -> Result<Self, String> {
        let root = canonical(root)?;
        let names = git_files(&root)?;
        let fd = open_root(&root).map_err(|e| e.to_string())?;
        let start = Instant::now();
        let mut s = Self {
            root,
            files: BTreeMap::new(),
            warnings: vec![],
            complete: true,
        };
        let mut used = 0;
        for name in names {
            if start.elapsed() > Duration::from_secs(10) {
                s.complete = false;
                s.warnings.push("snapshot deadline exceeded".into());
                break;
            }
            match read_state(&fd, &name) {
                Ok(Some(mut v)) => {
                    if used + v.text.as_ref().map_or(0, String::len) > SNAPSHOT_MAX_BYTES {
                        v.text = None;
                    }
                    if let Some(t) = &v.text {
                        used += t.len()
                    } else {
                        s.complete = false;
                        s.warnings.push(format!(
                            "{name}: binary, oversized or snapshot budget exceeded"
                        ));
                    }
                    s.files.insert(name, v);
                }
                Ok(None) => {}
                Err(e) => {
                    s.complete = false;
                    s.warnings.push(format!("{name}: {e}"));
                }
            }
        }
        s.warnings.sort();
        s.warnings.dedup();
        if s.warnings.len() > 16 {
            s.warnings.truncate(16);
            s.warnings
                .push("Additional snapshot warnings omitted.".into());
        }
        for warning in &mut s.warnings {
            if warning.len() > 256 {
                let mut end = 256;
                while !warning.is_char_boundary(end) {
                    end -= 1;
                }
                warning.truncate(end);
            }
        }
        Ok(s)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn diff(&self, after: &Self) -> TurnDiff {
        let mut names: Vec<_> = self.files.keys().chain(after.files.keys()).collect();
        names.sort();
        names.dedup();
        let mut d = TurnDiff {
            status: if self.complete && after.complete {
                DiffStatus::Complete
            } else {
                DiffStatus::Partial
            },
            files: vec![],
            warnings: self
                .warnings
                .iter()
                .chain(&after.warnings)
                .cloned()
                .collect(),
            added: 0,
            removed: 0,
            next_offset: None,
        };
        let mut used = 0;
        for n in names {
            let a = self.files.get(n);
            let b = after.files.get(n);
            if matches!((a,b),(Some(x),Some(y))if x.hash==y.hash&&x.mode==y.mode) {
                continue;
            }
            let old = a.map_or(Some(""), |s| s.text.as_deref());
            let new = b.map_or(Some(""), |s| s.text.as_deref());
            let mut f = FileDiff {
                path: n.clone(),
                status: if a.is_none() {
                    FileStatus::Added
                } else if b.is_none() {
                    FileStatus::Deleted
                } else {
                    FileStatus::Modified
                },
                before_hash: a.map(|s| s.hash.clone()),
                after_hash: b.map(|s| s.hash.clone()),
                before: None,
                after: None,
                old_mode: a.map(|s| s.mode),
                new_mode: b.map(|s| s.mode),
                added: 0,
                removed: 0,
                patch: None,
                omitted: None,
            };
            if let (Some(x), Some(y)) = (old, new) {
                if used + x.len() + y.len() <= DETAIL_MAX_BYTES {
                    (f.added, f.removed) = line_counts(x, y);
                    f.before = Some(x.into());
                    f.after = Some(y.into());
                    used += x.len() + y.len();
                } else {
                    f.omitted = Some("4 MiB detail budget exceeded".into());
                }
            } else {
                f.omitted = Some("complete text unavailable".into());
            }
            if f.omitted.is_some() {
                d.status = DiffStatus::Partial;
            }
            d.added += f.added;
            d.removed += f.removed;
            d.files.push(f);
        }
        if d.files
            .iter()
            .any(|f| f.path.split('/').next_back() == Some(".gitignore"))
        {
            // A newly visible untracked file may have existed before the turn.
            // Never call it safely undoable merely because ignore rules changed.
            d.status = DiffStatus::Partial;
            d.warnings.push("Ignore rules changed; newly visible files may predate this turn. Undo is disabled.".into());
        }
        d.warnings.sort();
        d.warnings.dedup();
        d
    }
}
fn line_counts(old: &str, new: &str) -> (u64, u64) {
    let a: Vec<_> = old.split_inclusive('\n').collect();
    let b: Vec<_> = new.split_inclusive('\n').collect();
    let p = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let a = &a[p..];
    let b = &b[p..];
    let s = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let a = &a[..a.len() - s];
    let b = &b[..b.len() - s];
    if a.len().saturating_mul(b.len()) > 1_000_000 {
        return (b.len() as u64, a.len() as u64);
    }
    let mut row = vec![0; b.len() + 1];
    for x in a {
        let mut diag = 0;
        for (j, y) in b.iter().enumerate() {
            let prev = row[j + 1];
            row[j + 1] = if x == y {
                diag + 1
            } else {
                row[j + 1].max(row[j])
            };
            diag = prev;
        }
    }
    (
        (b.len() - row[b.len()]) as u64,
        (a.len() - row[b.len()]) as u64,
    )
}
pub fn canonical(p: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(p).map_err(|_| "workspace unavailable".into())
}
pub fn snapshot_from_workspace(p: &crate::domain::WorkspacePath) -> Result<Snapshot, String> {
    Snapshot::capture(Path::new(p.as_str()))
}
pub fn summary(
    diff: Option<TurnDiff>,
    offset: usize,
) -> Result<TurnDiff, crate::domain::query::QueryError> {
    let Some(d) = diff else {
        return Ok(TurnDiff {
            status: DiffStatus::Unavailable,
            files: vec![],
            warnings: vec!["No workspace diff was captured for this turn.".into()],
            added: 0,
            removed: 0,
            next_offset: None,
        });
    };
    if offset > d.files.len() {
        return Err(crate::domain::query::QueryError::InvalidInput);
    }
    let count = d.files.len();
    let end = (offset + 16).min(count);
    let mut out = TurnDiff {
        status: d.status,
        files: d.files.into_iter().skip(offset).take(16).collect(),
        warnings: d.warnings,
        added: d.added,
        removed: d.removed,
        next_offset: (end < count).then_some(end),
    };
    for f in &mut out.files {
        if f.before.is_some() || f.after.is_some() {
            f.before = None;
            f.after = None;
            if f.omitted.is_none() {
                f.omitted = Some("Diff content can be loaded in bounded slices.".into());
            }
        }
    }
    Ok(out)
}
pub fn content(
    diff: &TurnDiff,
    file: usize,
    after: bool,
    offset: usize,
) -> Result<DiffContent, crate::domain::query::QueryError> {
    let r = diff
        .files
        .get(file)
        .ok_or(crate::domain::query::QueryError::InvalidInput)?;
    let t = if after {
        r.after.as_ref()
    } else {
        r.before.as_ref()
    }
    .ok_or(crate::domain::query::QueryError::InvalidInput)?;
    if !t.is_char_boundary(offset) || offset > t.len() {
        return Err(crate::domain::query::QueryError::InvalidInput);
    }
    let mut end = (offset + 64 * 1024).min(t.len());
    while !t.is_char_boundary(end) {
        end -= 1;
    }
    Ok(DiffContent {
        bytes: t[offset..end].into(),
        total_bytes: t.len(),
        next_offset: (end < t.len()).then_some(end),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::Command};
    fn repo() -> PathBuf {
        let p = std::env::temp_dir().join(format!("review-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&p)
            .status()
            .unwrap();
        p
    }
    #[test]
    fn over_budget_and_missing_capture_are_partial_and_never_undoable() {
        let root = repo();
        let large = root.join("large.txt");
        fs::write(&large, vec![b'x'; (FILE_MAX_BYTES + 1) as usize]).unwrap();
        Command::new("git")
            .args(["add", "large.txt"])
            .current_dir(&root)
            .status()
            .unwrap();
        let partial = Snapshot::capture(&root).unwrap();
        assert!(!partial.complete);
        let missing = Snapshot::unavailable(root.clone(), "capture failed".into());
        assert!(matches!(partial.diff(&missing).status, DiffStatus::Partial));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changing_ignore_rules_cannot_make_preexisting_files_undoable_as_added() {
        let root = repo();
        fs::write(root.join(".gitignore"), "hidden\n").unwrap();
        fs::write(root.join("hidden"), "preexisting user data").unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(root.join(".gitignore"), "").unwrap();
        let diff = before.diff(&Snapshot::capture(&root).unwrap());
        assert_eq!(diff.status, DiffStatus::Partial);
        assert!(crate::workspace_undo::undo(&root, &diff, false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("hidden")).unwrap(),
            "preexisting user data"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn file_count_snapshot_and_detail_budgets_fail_closed() {
        let root = repo();
        for i in 0..=FILES_MAX {
            fs::write(root.join(format!("f{i:04}")), "x").unwrap();
        }
        assert!(Snapshot::capture(&root).unwrap_err().contains("5000"));
        fs::remove_dir_all(&root).unwrap();
        let root = repo();
        for i in 0..17 {
            fs::write(
                root.join(format!("f{i:02}")),
                vec![b'x'; FILE_MAX_BYTES as usize],
            )
            .unwrap();
        }
        let over_snapshot = Snapshot::capture(&root).unwrap();
        assert!(!over_snapshot.complete);
        assert!(
            over_snapshot
                .files
                .values()
                .filter_map(|f| f.text.as_ref())
                .map(String::len)
                .sum::<usize>()
                <= SNAPSHOT_MAX_BYTES
        );
        fs::remove_dir_all(&root).unwrap();
        let root = repo();
        for i in 0..3 {
            fs::write(
                root.join(format!("f{i}")),
                vec![b'x'; FILE_MAX_BYTES as usize],
            )
            .unwrap();
        }
        let before = Snapshot::capture(&root).unwrap();
        for i in 0..3 {
            fs::write(
                root.join(format!("f{i}")),
                vec![b'y'; FILE_MAX_BYTES as usize],
            )
            .unwrap();
        }
        let diff = before.diff(&Snapshot::capture(&root).unwrap());
        assert_eq!(diff.status, DiffStatus::Partial);
        assert!(diff.files.iter().any(|f| f.omitted.is_some()));
        assert!(
            diff.files
                .iter()
                .map(|f| f.before.as_ref().map_or(0, String::len)
                    + f.after.as_ref().map_or(0, String::len))
                .sum::<usize>()
                <= DETAIL_MAX_BYTES
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn snapshots_net_text_permission_and_added_deleted() {
        let root = repo();
        let f = root.join("a.txt");
        fs::write(&f, "before\nkeep\n").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&root)
            .status()
            .unwrap();
        let before = Snapshot::capture(&root).unwrap();
        fs::write(&f, "after\nkeep\n").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o640)).unwrap();
        fs::write(root.join("new"), "new\n").unwrap();
        let after = Snapshot::capture(&root).unwrap();
        let d = before.diff(&after);
        assert_eq!(d.status, DiffStatus::Complete);
        assert_eq!((d.added, d.removed), (2, 1));
        assert_eq!(d.files.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
