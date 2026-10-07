//! WorkspaceDiff + turnDiffText port (src/workspace-diff.ts + turn-diff.ts).
//! Read-only git commands only — never stage/reset/commit or external diff tools.
//!
//! DIFF_LIMITS: files 5000, fileBytes 1 MiB, snapshotBytes 16 MiB, resultBytes
//! 4 MiB, commandMs 10 s, collectionMs 15 s.
//!
//! Port notes:
//! - git() helper: `git --no-pager --no-optional-locks -c core.fsmonitor=false
//!   -c core.autocrlf=false <args>` with all GIT_* env stripped, 10s timeout,
//!   2 MiB maxBuffer (custom for diff); non-zero exit → 'Git 修改采集失败或超过时间/大小限制。'
//!   except diff --no-index exit 1 (allowed).
//! - readState(root, name, budget): resolve + inside-workspace check
//!   ('文件路径超出工作区'); realpath(dirname) inside check ('目录链接超出工作区');
//!   lstat mode = mode & 0o177777; signature `metadata:${mode}:${size}:${mtimeMs}:${ctimeMs}`;
//!   symlink → signature `link:${target}` + text=target; non-regular →
//!   {signature, omitted:'非普通文件（目录或子模块）'}; over file/snapshot budget →
//!   {signature, omitted:'文件或快照超过采集上限'}; else open O_RDONLY|O_NOFOLLOW|
//!   O_NONBLOCK, verify ino/dev match (replacement → '采集时文件发生替换'),
//!   realpath(/proc/self/fd/N) inside check ('打开的文件超出工作区'), read ≤limit,
//!   final stat must match mtime/size ('采集期间文件发生变化'), sha256 → text
//!   only if valid UTF-8 without NUL else {signature:hash, omitted:'二进制或非 UTF-8 文件，不展示内容'}.
//! - capture(root, known=[]): names = git ls-files -z --cached --others
//!   --exclude-standard -- . plus `known`; >5000 → '工作区超过 5000 个文件，未采集完整差异。';
//!   per file readState failures → {signature:'unreadable', omitted:'文件无法安全读取'};
//!   warnings: `${n} 个文件未采集文本内容（大小限制、二进制、子模块或读取失败）。` when omitted>0.
//! - compare(before,after): union sorted names; skip same signature+mode;
//!   status added|deleted|modified + oldMode/newMode; omitted passthrough;
//!   patch via tempdir + git diff --no-index --no-ext-diff --no-textconv --no-color
//!   --unified=3 -- before after; added/removed = +/- hunk lines; headers built
//!   with JSON.stringify-quoted paths (`diff --git "a/x" "b/x"` etc.) — reproduce
//!   new file mode/deleted file mode/old mode lines exactly (octal modes);
//!   resultBytes budget → strip before/after/patch + omitted note; .gitignore
//!   change → warning '本轮忽略规则发生变化；新增文件列表可能包含此前被忽略的文件。'.
//! - WorkspaceDiff::begin(cwd): realpath; not a git worktree →
//!   error '无法建立本轮基线：需要 Git 工作区且文件数量/体积在采集限制内。{msg}'.
//! - finish(): compare → diff entry {id:next_id(), role:'diff', text:turnDiffText,
//!   diff}; always appends scope line '工作区本轮开始到结束的净变化；不含 Git 忽略文件。并发的手工或其他会话修改也可能计入；不是文件回滚点。'.
//! - turnDiffTitle/Text: '本轮修改 · {files} 个文件 · +{added} −{removed}' +
//!   '（部分结果）' when partial; '本轮修改 · 未能采集' when unavailable;
//!   per file '{path}: +{added} −{removed}' + ' · {omitted}'; then warnings.
use crate::types::{Entry, TurnDiff, TurnFileDiff};
use crate::updates::next_id;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

// DIFF_LIMITS from src/workspace-diff.ts.
const FILES_LIMIT: usize = 5000;
const FILE_BYTES: u64 = 1024 * 1024;
const SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
const RESULT_BYTES: u64 = 4 * 1024 * 1024;
const COMMAND_MS: u64 = 10_000;
const COLLECTION_MS: u64 = 15_000;
const GIT_MAX_BUFFER: usize = 2 * 1024 * 1024;
const GIT_FAILURE: &str = "Git 修改采集失败或超过时间/大小限制。";
const SCOPE: &str =
    "工作区本轮开始到结束的净变化；不含 Git 忽略文件。并发的手工或其他会话修改也可能计入；不是文件回滚点。";

pub struct WorkspaceDiff {
    root: PathBuf,
    before: Option<Capture>,
    error: Option<String>,
}

pub struct Capture {
    pub files: std::collections::HashMap<String, FileState>,
    pub warnings: Vec<String>,
}

pub struct FileState {
    pub signature: String,
    pub text: Option<String>,
    pub mode: u64,
    pub omitted: Option<String>,
}

/// JavaScript `Array.prototype.sort()` order = UTF-16 code-unit order
/// (pi-acp-core::canonical uses the same rule for object keys).
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Node `path.resolve(root, name)`: lexical join + normalization only.
fn resolve(root: &Path, name: &str) -> PathBuf {
    let joined = root.join(name);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !joined.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node `path.relative`-based inside check: path must be inside or equal to root.
fn inside(root: &Path, path: &Path) -> bool {
    normalize(path).strip_prefix(normalize(root)).is_ok()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !path.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6
}

fn ctime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.ctime() as f64 * 1000.0 + meta.ctime_nsec() as f64 / 1e6
}

fn is_enoent(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENOENT)
}

/// Read-only git subprocess — see the TS `git()` helper. Never passes args that
/// mutate the worktree; `allow_diff` exists only for `diff --no-index` exit 1.
async fn git(cwd: &Path, args: &[&str], max_buffer: usize, allow_diff: bool) -> Result<String, String> {
    let run = async {
        let mut command = tokio::process::Command::new("git");
        command
            .arg("--no-pager")
            .arg("--no-optional-locks")
            .arg("-c")
            .arg("core.fsmonitor=false")
            .arg("-c")
            .arg("core.autocrlf=false")
            .args(args)
            .current_dir(cwd)
            // execFile strips every GIT_* variable from the inherited env.
            .envs(std::env::vars_os().filter(|(k, _)| !k.to_string_lossy().starts_with("GIT_")))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| GIT_FAILURE.to_string())?;
        let mut stdout = child.stdout.take().ok_or_else(|| GIT_FAILURE.to_string())?;
        // execFile maxBuffer: too much stdout kills the child and fails the call.
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let overflow = loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => break false,
                Ok(n) => {
                    let remaining = (max_buffer + 1).saturating_sub(buffer.len());
                    buffer.extend_from_slice(&chunk[..n.min(remaining)]);
                    if buffer.len() > max_buffer {
                        break true;
                    }
                }
                Err(_) => break false,
            }
        };
        if overflow {
            let _ = child.kill().await;
        }
        let status = child.wait().await.map_err(|_| GIT_FAILURE.to_string())?;
        if overflow {
            return Err(GIT_FAILURE.to_string());
        }
        let ok = status.success() || (allow_diff && status.code() == Some(1));
        if !ok {
            return Err(GIT_FAILURE.to_string());
        }
        String::from_utf8(buffer).map_err(|_| GIT_FAILURE.to_string())
    };
    match tokio::time::timeout(Duration::from_millis(COMMAND_MS), run).await {
        Ok(result) => result,
        Err(_) => Err(GIT_FAILURE.to_string()),
    }
}

/// Port of readState(). Ok(None) mirrors the TS `ENOENT → return undefined`
/// path (file disappeared between ls-files and read). Any other error is
/// reported to capture() which records the file as unreadable.
async fn read_state(root: &Path, name: &str, budget: &mut u64) -> Result<Option<FileState>, String> {
    use std::os::unix::fs::MetadataExt;
    let file = resolve(root, name);
    if !inside(root, &file) {
        return Err("文件路径超出工作区".into());
    }
    let inner: Result<Option<FileState>, ReadFail> = async {
        // Do not follow directory symlinks into secrets or unrelated workspaces.
        let parent = file.parent().unwrap_or(root);
        let real_parent = tokio::fs::canonicalize(parent).await?;
        if !inside(root, &real_parent) {
            return Err("目录链接超出工作区".into());
        }
        let info = tokio::fs::symlink_metadata(&file).await?;
        let mode = (info.mode() & 0o177777) as u64;
        let signature = format!("metadata:{}:{}:{}:{}", mode, info.size(), mtime_ms(&info), ctime_ms(&info));
        if info.file_type().is_symlink() {
            let text = tokio::fs::read_link(&file).await?;
            let text = text.to_string_lossy().into_owned();
            return Ok(Some(FileState { signature: format!("link:{text}"), text: Some(text), mode, omitted: None }));
        }
        if !info.is_file() {
            return Ok(Some(FileState { signature, text: None, mode, omitted: Some("非普通文件（目录或子模块）".into()) }));
        }
        if info.size() > FILE_BYTES || *budget + info.size() > SNAPSHOT_BYTES {
            return Ok(Some(FileState { signature, text: None, mode, omitted: Some("文件或快照超过采集上限".into()) }));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let std_file = options.open(&file)?;
        let mut handle = tokio::fs::File::from_std(std_file);
        let bytes = async {
            let opened = handle.metadata().await.map_err(|e| e.to_string())?;
            if !opened.is_file() || opened.ino() != info.ino() || opened.dev() != info.dev() {
                return Err("采集时文件发生替换".to_string());
            }
            #[cfg(target_os = "linux")]
            let actual = {
                use std::os::unix::io::AsRawFd;
                tokio::fs::canonicalize(format!("/proc/self/fd/{}", handle.as_raw_fd()))
                    .await
                    .map_err(|e| e.to_string())?
            };
            #[cfg(not(target_os = "linux"))]
            let actual = tokio::fs::canonicalize(&file).await.map_err(|e| e.to_string())?;
            if !inside(root, &actual) {
                return Err("打开的文件超出工作区".to_string());
            }
            let limit = (info.size() + 1)
                .min(FILE_BYTES + 1)
                .min(SNAPSHOT_BYTES.saturating_sub(*budget) + 1) as usize;
            let mut buffer = vec![0u8; limit];
            let mut length = 0usize;
            while length < buffer.len() {
                let n = handle.read(&mut buffer[length..]).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                length += n;
            }
            let final_meta = handle.metadata().await.map_err(|e| e.to_string())?;
            if length as u64 != info.size()
                || mtime_ms(&final_meta) != mtime_ms(&info)
                || final_meta.size() != info.size()
            {
                return Err("采集期间文件发生变化".to_string());
            }
            if length as u64 > FILE_BYTES || *budget + length as u64 > SNAPSHOT_BYTES {
                return Err("读取时文件超过采集上限".to_string());
            }
            buffer.truncate(length);
            *budget += length as u64;
            Ok::<Vec<u8>, String>(buffer)
        }
        .await?; // `handle` drops on the error path too, matching TS `finally { handle.close() }`
        let hash = hex::encode(Sha256::digest(&bytes));
        // TextDecoder fatal+ignoreBOM: valid UTF-8 without NUL bytes only.
        match std::str::from_utf8(&bytes) {
            Ok(text) if !text.contains('\0') => Ok(Some(FileState {
                signature: hash,
                text: Some(text.to_string()),
                mode,
                omitted: None,
            })),
            _ => Ok(Some(FileState {
                signature: hash,
                text: None,
                mode,
                omitted: Some("二进制或非 UTF-8 文件，不展示内容".into()),
            })),
        }
    }
    .await;
    match inner {
        Ok(v) => Ok(v),
        Err(ReadFail::Io(e)) if is_enoent(&e) => Ok(None),
        Err(ReadFail::Io(e)) => Err(e.to_string()),
        Err(ReadFail::Msg(m)) => Err(m),
    }
}

/// Internal read-state error carrier so io errors keep ENOENT identity.
enum ReadFail {
    Io(std::io::Error),
    Msg(String),
}

impl From<std::io::Error> for ReadFail {
    fn from(e: std::io::Error) -> Self {
        ReadFail::Io(e)
    }
}

impl From<String> for ReadFail {
    fn from(m: String) -> Self {
        ReadFail::Msg(m)
    }
}

impl From<&str> for ReadFail {
    fn from(m: &str) -> Self {
        ReadFail::Msg(m.to_string())
    }
}

async fn capture(root: &Path, known: impl Iterator<Item = String>) -> Result<Capture, String> {
    // Relative paths from ls-files are relative to cwd, so a nested workspace stays scoped to that directory.
    let listed = git(
        root,
        &["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
        GIT_MAX_BUFFER,
        false,
    )
    .await?;
    let mut names: HashSet<String> = listed.split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
    for name in known {
        names.insert(name); // An ignore-rule change must not masquerade as deletion.
    }
    if names.len() > FILES_LIMIT {
        return Err(format!("工作区超过 {FILES_LIMIT} 个文件，未采集完整差异。"));
    }
    let mut result = Capture { files: HashMap::new(), warnings: Vec::new() };
    let mut budget = 0u64;
    let deadline = Instant::now() + Duration::from_millis(COLLECTION_MS);
    let mut sorted: Vec<String> = names.into_iter().collect();
    sorted.sort_by(|a, b| utf16_cmp(a, b));
    for name in sorted {
        if Instant::now() > deadline {
            return Err("工作区文件采集超过时间限制。".into());
        }
        match read_state(root, &name, &mut budget).await {
            Ok(Some(state)) => {
                result.files.insert(name, state);
            }
            Ok(None) => {}
            Err(_) => {
                result.files.insert(
                    name,
                    FileState {
                        signature: "unreadable".into(),
                        text: None,
                        mode: 0,
                        omitted: Some("文件无法安全读取".into()),
                    },
                );
            }
        }
    }
    let omitted = result.files.values().filter(|f| f.omitted.is_some()).count();
    if omitted > 0 {
        result
            .warnings
            .push(format!("{omitted} 个文件未采集文本内容（大小限制、二进制、子模块或读取失败）。"));
    }
    Ok(result)
}

/// JSON.stringify(prefix + name) for patch headers — serde_json's string
/// escapes match JSON.stringify (" \ and <0x20 only, non-ASCII raw).
fn label(prefix: &str, name: &str) -> String {
    serde_json::to_string(&format!("{prefix}{name}")).unwrap_or_else(|_| "\"\"".into())
}

async fn compare(before: &Capture, after: &Capture) -> Result<TurnDiff, String> {
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for w in before.warnings.iter().chain(after.warnings.iter()) {
        if seen.insert(w.as_str()) {
            warnings.push(w.clone());
        }
    }
    let mut diff = TurnDiff {
        status: if warnings.is_empty() { "complete".into() } else { "partial".into() },
        files: Vec::new(),
        warnings,
    };
    let mut directory: Option<PathBuf> = None;
    let mut used = 0u64;
    let deadline = Instant::now() + Duration::from_millis(COLLECTION_MS);
    let result = async {
        let mut names: HashSet<&String> = before.files.keys().chain(after.files.keys()).collect();
        let mut names: Vec<&String> = names.drain().collect();
        names.sort_by(|a, b| utf16_cmp(a, b));
        for name in names {
            let old = before.files.get(name);
            let current = after.files.get(name);
            if let (Some(o), Some(c)) = (old, current) {
                if o.signature == c.signature && o.mode == c.mode {
                    continue;
                }
            }
            let mut file = TurnFileDiff {
                path: name.clone(),
                status: if old.is_none() {
                    "added".into()
                } else if current.is_none() {
                    "deleted".into()
                } else {
                    "modified".into()
                },
                added: 0,
                removed: 0,
                before: None,
                after: None,
                patch: None,
                old_mode: old.map(|o| o.mode),
                new_mode: current.map(|c| c.mode),
                omitted: None,
            };
            if old.is_some_and(|o| o.omitted.is_some()) || current.is_some_and(|c| c.omitted.is_some()) {
                file.omitted = old
                    .and_then(|o| o.omitted.clone())
                    .or_else(|| current.and_then(|c| c.omitted.clone()));
            } else if Instant::now() > deadline {
                file.omitted = Some("本轮补丁计算超过时间限制".into());
            } else {
                let old_text = old.and_then(|o| o.text.clone()).unwrap_or_default();
                let new_text = current.and_then(|c| c.text.clone()).unwrap_or_default();
                if old_text.len() as u64 + new_text.len() as u64 + used > RESULT_BYTES {
                    file.omitted = Some("本轮差异内容超过展示上限".into());
                } else {
                    if directory.is_none() {
                        let dir = std::env::temp_dir().join(format!("pi-turn-diff-{}", uuid::Uuid::new_v4().simple()));
                        tokio::fs::create_dir(&dir).await.map_err(|e| e.to_string())?;
                        directory = Some(dir);
                    }
                    let dir = directory.clone().unwrap();
                    // writeFile(join(directory,'before'|'after'), text, {mode:0o600})
                    let write_file = |name: &str, text: &str| -> std::io::Result<()> {
                        use std::os::unix::fs::OpenOptionsExt;
                        let mut o = std::fs::OpenOptions::new();
                        o.write(true).create(true).truncate(true).mode(0o600);
                        let mut f = o.open(dir.join(name))?;
                        std::io::Write::write_all(&mut f, text.as_bytes())
                    };
                    write_file("before", &old_text).map_err(|e| e.to_string())?;
                    write_file("after", &new_text).map_err(|e| e.to_string())?;
                    let patch_result = git(
                        &dir,
                        &[
                            "diff",
                            "--no-index",
                            "--no-ext-diff",
                            "--no-textconv",
                            "--no-color",
                            "--unified=3",
                            "--",
                            "before",
                            "after",
                        ],
                        GIT_MAX_BUFFER,
                        true,
                    )
                    .await;
                    match patch_result {
                        Ok(raw) => {
                            let lines: Vec<&str> = raw.split('\n').collect();
                            let start = lines.iter().position(|l| l.starts_with("@@"));
                            let hunks: Vec<&str> = start.map(|s| lines[s..].to_vec()).unwrap_or_default();
                            file.added = hunks.iter().filter(|l| l.starts_with('+')).count() as u64;
                            file.removed = hunks.iter().filter(|l| l.starts_with('-')).count() as u64;
                            let mut headers = vec![format!("diff --git {} {}", label("a/", name), label("b/", name))];
                            match (old, current) {
                                (None, Some(c)) => headers.push(format!("new file mode {:o}", c.mode)),
                                (Some(o), None) => headers.push(format!("deleted file mode {:o}", o.mode)),
                                (Some(o), Some(c)) if o.mode != c.mode => {
                                    headers.push(format!("old mode {:o}", o.mode));
                                    headers.push(format!("new mode {:o}", c.mode));
                                }
                                _ => {}
                            }
                            headers.push(format!("--- {}", if old.is_some() { label("a/", name) } else { "/dev/null".into() }));
                            headers.push(format!("+++ {}", if current.is_some() { label("b/", name) } else { "/dev/null".into() }));
                            file.patch = Some(
                                headers
                                    .iter()
                                    .cloned()
                                    .chain(hunks.iter().map(|s| s.to_string()))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            );
                            file.before = Some(old_text);
                            file.after = Some(new_text);
                            let bytes = serde_json::to_string(&file).map(|s| s.len() as u64).unwrap_or(u64::MAX);
                            if used + bytes > RESULT_BYTES {
                                file.before = None;
                                file.after = None;
                                file.patch = None;
                                file.omitted = Some("本轮差异内容超过展示上限".into());
                            } else {
                                used += bytes;
                            }
                        }
                        Err(_) => file.omitted = Some("未能生成此文件的差异".into()),
                    }
                }
            }
            if file.omitted.is_some() {
                diff.status = "partial".into();
            }
            diff.files.push(file);
        }
        if diff.files.iter().any(|f| f.path.ends_with(".gitignore")) {
            diff.warnings
                .push("本轮忽略规则发生变化；新增文件列表可能包含此前被忽略的文件。".into());
        }
        Ok::<(), String>(())
    }
    .await;
    if let Some(dir) = directory {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    result?;
    Ok(diff)
}

impl WorkspaceDiff {
    /// One baseline per actual prompt. The caller owns finalization even on cancellation/error.
    pub async fn begin(cwd: &str) -> Self {
        async fn inner(cwd: &str) -> Result<(PathBuf, Capture), String> {
            let root = tokio::fs::canonicalize(cwd).await.map_err(|e| e.to_string())?;
            if git(&root, &["rev-parse", "--is-inside-work-tree"], GIT_MAX_BUFFER, false)
                .await?
                .trim()
                != "true"
            {
                return Err("not a worktree".into());
            }
            let before = capture(&root, std::iter::empty()).await?;
            Ok((root, before))
        }
        match inner(cwd).await {
            Ok((root, before)) => WorkspaceDiff { root, before: Some(before), error: None },
            Err(e) => WorkspaceDiff {
                root: PathBuf::from(cwd),
                before: None,
                error: Some(format!("无法建立本轮基线：需要 Git 工作区且文件数量/体积在采集限制内。{e}")),
            },
        }
    }

    /// Always produces the diff entry (unavailable diff on failure).
    pub async fn finish(&mut self) -> Entry {
        let mut diff = match self.before.take() {
            None => TurnDiff {
                status: "unavailable".into(),
                files: Vec::new(),
                warnings: vec![self.error.clone().unwrap_or_default()],
            },
            Some(before) => {
                let attempt = async {
                    let after = capture(&self.root, before.files.keys().cloned()).await?;
                    compare(&before, &after).await
                };
                match attempt.await {
                    Ok(diff) => diff,
                    Err(e) => TurnDiff { status: "unavailable".into(), files: Vec::new(), warnings: vec![e] },
                }
            }
        };
        diff.warnings.push(SCOPE.to_string());
        let mut entry = Entry::text_entry(next_id(), "diff", turn_diff_text(&diff));
        entry.diff = Some(diff);
        entry
    }
}

pub fn turn_diff_title(diff: &TurnDiff) -> String {
    if diff.status == "unavailable" {
        return "本轮修改 · 未能采集".into();
    }
    let added: u64 = diff.files.iter().map(|f| f.added).sum();
    let removed: u64 = diff.files.iter().map(|f| f.removed).sum();
    format!(
        "本轮修改 · {} 个文件 · +{} −{}{}",
        diff.files.len(),
        added,
        removed,
        if diff.status == "partial" { "（部分结果）" } else { "" }
    )
}

pub fn turn_diff_text(diff: &TurnDiff) -> String {
    let mut lines = vec![turn_diff_title(diff)];
    for file in &diff.files {
        lines.push(format!(
            "{}: +{} −{}{}",
            file.path,
            file.added,
            file.removed,
            file.omitted.as_deref().map(|o| format!(" · {o}")).unwrap_or_default()
        ));
    }
    lines.extend(diff.warnings.iter().cloned());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, status: &str, added: u64, removed: u64, omitted: Option<&str>) -> TurnFileDiff {
        TurnFileDiff {
            path: path.into(),
            status: status.into(),
            added,
            removed,
            before: None,
            after: None,
            patch: None,
            old_mode: None,
            new_mode: None,
            omitted: omitted.map(str::to_string),
        }
    }

    #[test]
    fn title_and_text_format() {
        let diff = TurnDiff {
            status: "complete".into(),
            files: vec![file("a.ts", "modified", 3, 1, None)],
            warnings: vec![],
        };
        assert_eq!(turn_diff_title(&diff), "本轮修改 · 1 个文件 · +3 −1");
        assert_eq!(turn_diff_text(&diff), "本轮修改 · 1 个文件 · +3 −1\na.ts: +3 −1");

        let partial = TurnDiff {
            status: "partial".into(),
            files: vec![file("b.bin", "added", 1, 0, Some("二进制或非 UTF-8 文件，不展示内容"))],
            warnings: vec!["w".into()],
        };
        assert_eq!(
            turn_diff_text(&partial),
            "本轮修改 · 1 个文件 · +1 −0（部分结果）\nb.bin: +1 −0 · 二进制或非 UTF-8 文件，不展示内容\nw"
        );

        let unavailable = TurnDiff { status: "unavailable".into(), files: vec![], warnings: vec!["boom".into()] };
        assert_eq!(turn_diff_title(&unavailable), "本轮修改 · 未能采集");
        assert_eq!(turn_diff_text(&unavailable), "本轮修改 · 未能采集\nboom");
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git must be available for this test");
        assert!(status.status.success(), "git {args:?} failed: {:?}", String::from_utf8_lossy(&status.stderr));
    }

    #[tokio::test]
    async fn workspace_diff_reports_changes() {
        let dir = std::env::temp_dir().join(format!("pi-diff-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        git_ok(&dir, &["init"]);
        git_ok(&dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_ok(&dir, &["add", "a.txt"]);
        git_ok(&dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add"]);

        let mut changes = WorkspaceDiff::begin(dir.to_str().unwrap()).await;
        assert!(changes.error.is_none(), "baseline must succeed in a git worktree");
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        let entry = changes.finish().await;
        assert_eq!(entry.role, "diff");
        let diff = entry.diff.clone().expect("diff payload");
        assert_eq!(diff.status, "complete");
        let by_path: HashMap<&str, &TurnFileDiff> =
            diff.files.iter().map(|f| (f.path.as_str(), f)).collect();
        let a = by_path["a.txt"];
        assert_eq!((a.status.as_str(), a.added, a.removed), ("modified", 1, 0));
        assert!(a.patch.as_deref().unwrap().contains("diff --git \"a/a.txt\" \"b/a.txt\""));
        let b = by_path["b.txt"];
        assert_eq!(b.status, "added");
        assert!(b.patch.as_deref().unwrap().contains("new file mode 100"));
        assert_eq!(diff.warnings.last().map(String::as_str), Some(SCOPE));
        assert!(entry.text().starts_with("本轮修改 · 2 个文件"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn workspace_diff_unavailable_outside_git() {
        let dir = std::env::temp_dir().join(format!("pi-diff-nogit-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut changes = WorkspaceDiff::begin(dir.to_str().unwrap()).await;
        let entry = changes.finish().await;
        let diff = entry.diff.clone().unwrap();
        assert_eq!(diff.status, "unavailable");
        assert!(diff.warnings[0].contains("无法建立本轮基线"), "{:?}", diff.warnings);
        assert!(entry.text().starts_with("本轮修改 · 未能采集"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
