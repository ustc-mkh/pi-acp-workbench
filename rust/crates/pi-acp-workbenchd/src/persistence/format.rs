//! Host-wide exclusive storage lease and explicit on-disk format gate.
use super::FORMAT_VERSION;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatMarker {
    format_version: u32,
    storage_kind: String,
}

#[derive(Clone)]
pub struct StorageLease {
    file: Arc<LeaseFile>,
    root: PathBuf,
}
struct LeaseFile {
    file: File,
    database_open: AtomicBool,
}
pub(crate) struct DatabaseLease(StorageLease);
impl Drop for DatabaseLease {
    fn drop(&mut self) {
        self.0.file.database_open.store(false, Ordering::Release);
    }
}
impl Drop for LeaseFile {
    fn drop(&mut self) {
        // Explicit unlock also releases the lease if a concurrently spawned child
        // briefly inherited the open description between fork and exec.
        // SAFETY: the file descriptor remains valid throughout this destructor.
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
impl StorageLease {
    /// Maintenance validates an existing marker under the same stable flock.
    /// Only the database executor may initialize a root or complete its marker.
    pub fn acquire_existing(root: &Path) -> io::Result<Self> {
        validate_marker(root)?;
        let lease = Self::lock(root)?;
        validate_marker(root)?;
        Ok(lease)
    }
    /// Acquire only the existing stable host lock. Database initialization owns
    /// the format3 completion marker, so a failed open never marks success.
    pub fn lock(root: &Path) -> io::Result<Self> {
        if !root.is_absolute() {
            return Err(io::Error::other("storage root must be absolute"));
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)?;
        if !fs::symlink_metadata(root)?.is_dir() {
            return Err(io::Error::other("storage root must be a real directory"));
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join(".workbench.lock"))?;
        if !lock.metadata()?.is_file() {
            return Err(io::Error::other("storage lease must be a regular file"));
        }
        // SAFETY: the descriptor remains owned by LeaseFile until final drop.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "storage already owned by another workbench host",
            ));
        }
        Ok(Self {
            file: Arc::new(LeaseFile {
                file: lock,
                database_open: AtomicBool::new(false),
            }),
            root: fs::canonicalize(root)?,
        })
    }
    pub(crate) fn claim_database(&self) -> io::Result<DatabaseLease> {
        self.file
            .database_open
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| io::Error::other("database executor already open under this lease"))?;
        Ok(DatabaseLease(self.clone()))
    }
    pub(crate) fn owns(&self, root: &Path) -> bool {
        fs::canonicalize(root).is_ok_and(|path| path == self.root)
            && self.file.file.metadata().is_ok_and(|held| {
                fs::symlink_metadata(root.join(".workbench.lock")).is_ok_and(|current| {
                    use std::os::unix::fs::MetadataExt;
                    held.dev() == current.dev() && held.ino() == current.ino()
                })
            })
    }
}

pub(crate) fn validate_marker(root: &Path) -> io::Result<()> {
    read_marker(&root.join("storage-format.json"))
}
fn read_marker(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::other("storage marker must be a regular file"));
    }
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?
        .take(1025)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 {
        return Err(io::Error::other("storage marker exceeds size limit"));
    }
    let marker: FormatMarker = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if marker.format_version != FORMAT_VERSION || marker.storage_kind != "pi-acp-workbench" {
        return Err(io::Error::other("unsupported storage format"));
    }
    Ok(())
}

/// Called only by the database executor before opening/creating SQLite.
/// Returns true for a new/interrupted initialization and false for a valid root.
pub(crate) fn prepare_database(root: &Path) -> io::Result<bool> {
    let marker = root.join("storage-format.json");
    if marker.try_exists()? {
        read_marker(&marker)?;
        if !root.join("workbench.sqlite3").try_exists()? {
            return Err(io::Error::other("format3 database is missing"));
        }
        return Ok(false);
    }
    let pending = root.join("storage-format.pending");
    let interrupted = pending.try_exists()?;
    if interrupted {
        read_marker(&pending)?;
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let allowed = name == ".workbench.lock"
            || interrupted
                && matches!(
                    name.to_str(),
                    Some(
                        "storage-format.pending"
                            | "workbench.sqlite3"
                            | "workbench.sqlite3-wal"
                            | "workbench.sqlite3-shm"
                            | "workbench.sqlite3-journal"
                    )
                );
        if !allowed {
            return Err(io::Error::other(
                "unversioned storage directory is not empty; refusing database initialization",
            ));
        }
        if !entry.file_type()?.is_file() {
            return Err(io::Error::other(
                "database initialization contains non-regular files",
            ));
        }
    }
    if !interrupted {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(pending)?;
        file.write_all(
            &serde_json::to_vec(&FormatMarker {
                format_version: FORMAT_VERSION,
                storage_kind: "pi-acp-workbench".into(),
            })
            .map_err(io::Error::other)?,
        )?;
        file.sync_all()?;
        File::open(root)?.sync_all()?;
    }
    Ok(true)
}

pub(crate) fn complete_database(root: &Path) -> io::Result<()> {
    fs::rename(
        root.join("storage-format.pending"),
        root.join("storage-format.json"),
    )?;
    File::open(root)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("workbench-format-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn lease_excludes_another_host_and_releases_on_drop() {
        let root = root();
        let lease = StorageLease::lock(&root).unwrap();
        assert!(StorageLease::lock(&root).is_err());
        drop(lease);
        drop(StorageLease::lock(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    fn open_database(
        root: &Path,
    ) -> Result<super::super::database::Database, super::super::database::StoreError> {
        let lease = StorageLease::lock(root).unwrap();
        super::super::database::Database::open_sync(root, &lease)
    }
    #[test]
    fn frozen_legacy_format_samples_are_refused_byte_for_byte_without_migration() {
        let fixtures =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/formats");
        let mut files: Vec<_> = fs::read_dir(fixtures)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();
        assert_eq!(
            files.len(),
            6,
            "legacy rejection fixtures must actually run"
        );
        for fixture in files {
            let root = root();
            fs::create_dir(&root).unwrap();
            let path = root.join(fixture.file_name().unwrap());
            let original = fs::read(&fixture).unwrap();
            fs::write(&path, &original).unwrap();
            let error = open_database(&root)
                .err()
                .expect("legacy fixture must not be accepted or initialized");
            assert!(error.to_string().contains("unversioned storage"));
            assert!(StorageLease::acquire_existing(&root).is_err());
            assert_eq!(fs::read(&path).unwrap(), original, "{}", fixture.display());
            assert!(!root.join("storage-format.json").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn old_unversioned_and_corrupt_formats_fail_closed_without_deleting_data() {
        let root = root();
        fs::create_dir(&root).unwrap();
        let legacy = root.join("history-index.json");
        fs::write(&legacy, b"legacy data").unwrap();
        assert!(open_database(&root).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy data");
        assert!(!root.join("storage-format.json").exists());
        assert!(!root.join("workbench.sqlite3").exists());
        fs::remove_file(&legacy).unwrap();
        drop(open_database(&root).unwrap());
        for bytes in [
            b"{corrupt".as_slice(),
            b"{\"format_version\":1,\"storage_kind\":\"pi-acp-workbench\"}".as_slice(),
        ] {
            fs::write(root.join("storage-format.json"), bytes).unwrap();
            assert!(open_database(&root).is_err());
            assert_eq!(fs::read(root.join("storage-format.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
