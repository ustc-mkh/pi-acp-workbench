//! Read directory names only, under a fixed scan budget. Never read file bodies,
//! follow directory symlinks, create directories or start providers.
use crate::domain::{error::DomainError, WorkspacePath};
use std::{
    fs::OpenOptions,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
};
pub(super) const MAX_ENTRIES: usize = 1024;
pub(super) struct Page {
    pub names: Vec<String>,
    pub next: Option<String>,
    pub too_large: bool,
}
fn unavailable() -> DomainError {
    DomainError::InvalidAnswer("directory unavailable or changed".into())
}

pub(super) async fn list(
    cwd: WorkspacePath,
    after: Option<String>,
    limit: usize,
) -> Result<Page, DomainError> {
    tokio::task::spawn_blocking(move || {
        // Linux-only host: the owned directory FD anchors enumeration even if
        // the pathname is replaced. Check its canonical identity before/after.
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(cwd.as_ref())
            .map_err(|_| unavailable())?;
        let fd_path = format!("/proc/self/fd/{}", file.as_raw_fd());
        let check = || {
            if std::fs::canonicalize(&fd_path).map_err(|_| unavailable())?
                != Path::new(cwd.as_str())
            {
                return Err(unavailable());
            }
            Ok(())
        };
        check()?;
        let entries = std::fs::read_dir(&fd_path).map_err(|_| unavailable())?;
        let mut names = vec![];
        for (index, entry) in entries.enumerate() {
            if index >= MAX_ENTRIES {
                check()?;
                return Ok(Page {
                    names: vec![],
                    next: None,
                    too_large: true,
                });
            }
            let entry = entry.map_err(|_| unavailable())?;
            let kind = entry.file_type().map_err(|_| unavailable())?;
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if name.starts_with('.') || after.as_ref().is_some_and(|after| &name <= after) {
                continue;
            }
            names.push(name);
        }
        check()?;
        names.sort();
        let next = if names.len() > limit {
            names.truncate(limit);
            names.last().cloned()
        } else {
            None
        };
        Ok(Page {
            names,
            next,
            too_large: false,
        })
    })
    .await
    .map_err(|_| unavailable())?
}
