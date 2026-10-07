//! proper-lockfile-compatible mkdir lock (docs/data-formats.md §3):
//! `${path}.lock` directory, mtime heartbeat every `update`, stale after `stale`.
//! Never replace with flock: the TypeScript side may hold or inspect the same lock.
use std::fs::FileTimes;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::task::JoinHandle;

#[derive(Debug)]
pub enum LockError {
    /// Another process holds a live lock.
    Held,
    Io(io::Error),
}
impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held => write!(f, "锁已被其他进程持有"),
            LockError::Io(e) => write!(f, "锁失败：{e}"),
        }
    }
}
impl std::error::Error for LockError {}
impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

fn mtime(dir: &std::path::Path) -> io::Result<SystemTime> {
    std::fs::metadata(dir).and_then(|m| m.modified())
}

/// Try to take `${path}.lock`; steal it once if provably stale.
async fn take(dir: &PathBuf, stale: Duration) -> Result<bool, LockError> {
    match tokio::fs::create_dir(dir).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // TOCTOU: dir vanishing between create_dir and metadata is pure
            // contention — report Held rather than propagating an io error.
            let first = match mtime(dir) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(e) => return Err(e.into()),
            };
            if first.elapsed().unwrap_or_default() <= stale {
                return Ok(false);
            }
            // Confirm the holder is gone: mtime must not move while it looks stale.
            tokio::time::sleep(Duration::from_millis(250)).await;
            let second = match mtime(dir) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(e) => return Err(e.into()),
            };
            if second != first || second.elapsed().unwrap_or_default() <= stale {
                return Ok(false);
            }
            let _ = tokio::fs::remove_dir_all(dir).await;
            match tokio::fs::create_dir(dir).await {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(e.into()),
    }
}

pub struct MkdirLock {
    dir: PathBuf,
    compromised: Arc<AtomicBool>,
    heartbeat: JoinHandle<()>,
}

impl MkdirLock {
    /// Acquire the lock. `on_compromised` fires when the heartbeat can no longer
    /// refresh the lock dir (it was removed by someone else) — callers must abort
    /// the protected work rather than continue without mutual exclusion.
    pub async fn acquire<F>(
        path: &std::path::Path,
        update: Duration,
        stale: Duration,
        on_compromised: F,
    ) -> Result<Self, LockError>
    where
        F: FnOnce() + Send + 'static,
    {
        Self::acquire_retry(path, update, stale, 0, on_compromised).await
    }

    /// proper-lockfile retries: attempt `retries + 1` times with randomized
    /// 50–500 ms backoff between Held failures (retries:0 = fail fast).
    pub async fn acquire_retry<F>(
        path: &std::path::Path,
        update: Duration,
        stale: Duration,
        retries: u32,
        on_compromised: F,
    ) -> Result<Self, LockError>
    where
        F: FnOnce() + Send + 'static,
    {
        let dir = PathBuf::from(format!("{}.lock", path.display()));
        let mut attempt = 0u32;
        while !take(&dir, stale).await? {
            if attempt >= retries {
                return Err(LockError::Held);
            }
            attempt += 1;
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as u64;
            let delay = Duration::from_millis(50 + nanos % 450);
            tokio::time::sleep(delay).await;
        }
        let compromised = Arc::new(AtomicBool::new(false));
        let flag = compromised.clone();
        let lock_dir = dir.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(update).await;
                let refresh = || -> io::Result<()> {
                    std::fs::File::open(&lock_dir)?
                        .set_times(FileTimes::new().set_modified(SystemTime::now()))
                };
                if refresh().is_err() {
                    flag.store(true, Ordering::SeqCst);
                    on_compromised();
                    return;
                }
            }
        });
        Ok(MkdirLock {
            dir,
            compromised,
            heartbeat,
        })
    }
    pub fn compromised(&self) -> bool {
        self.compromised.load(Ordering::SeqCst)
    }
    pub async fn release(self) {
        self.heartbeat.abort();
        if !self.compromised.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_dir_all(&self.dir).await;
        }
    }
}

impl Drop for MkdirLock {
    fn drop(&mut self) {
        self.heartbeat.abort();
        // Compromised: the dir may already belong to a new holder — never
        // remove it (proper-lockfile semantics; matches history.rs callers that
        // previously had to mem::forget to avoid the cascade-delete).
        if !self.compromised.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}
