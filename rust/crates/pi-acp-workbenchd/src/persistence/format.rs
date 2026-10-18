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
    path::Path,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatMarker {
    format_version: u32,
    storage_kind: String,
}

pub struct StorageLease {
    _file: File,
}
impl Drop for StorageLease {
    fn drop(&mut self) {
        // Explicit unlock also releases the lease if a concurrently spawned child
        // briefly inherited the open description between fork and exec.
        // SAFETY: the file descriptor remains valid throughout this destructor.
        unsafe {
            libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
impl StorageLease {
    pub fn acquire(root: &Path) -> io::Result<Self> {
        Self::open(root, true)
    }
    /// Maintenance never initializes or guesses a missing/old format. The same
    /// stable flock inode excludes the host for the whole file transaction.
    pub fn acquire_existing(root: &Path) -> io::Result<Self> {
        Self::open(root, false)
    }
    fn open(root: &Path, initialize: bool) -> io::Result<Self> {
        if !root.is_absolute() {
            return Err(io::Error::other("storage root must be absolute"));
        }
        if initialize {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(root)?;
        }
        if !fs::symlink_metadata(root)?.is_dir() {
            return Err(io::Error::other("storage root must be a real directory"));
        }
        if !initialize {
            validate_marker(root)?;
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
        // SAFETY: flock borrows a valid open file descriptor. The owned file keeps
        // the exclusive lease alive and the kernel releases it after process loss.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "storage already owned by another workbench host",
            ));
        }
        let lease = Self { _file: lock };
        let marker = root.join("storage-format.json");
        match validate_marker(root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && initialize => {
                // No format guessing and no implicit migration or data deletion.
                for entry in fs::read_dir(root)? {
                    if entry?.file_name() != ".workbench.lock" {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "unversioned storage directory is not empty; old data must be backed up and explicitly cleaned offline"));
                    }
                }
                let pending = root.join("storage-format.pending");
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&pending)?;
                let body = serde_json::to_vec(&FormatMarker {
                    format_version: FORMAT_VERSION,
                    storage_kind: "pi-acp-workbench".into(),
                })
                .map_err(io::Error::other)?;
                file.write_all(&body)?;
                file.sync_all()?;
                drop(file);
                fs::rename(pending, marker)?;
                File::open(root)?.sync_all()?;
            }
            Err(error) => return Err(error),
        }
        Ok(lease)
    }
}

pub(crate) fn validate_marker(root: &Path) -> io::Result<()> {
    let path = root.join("storage-format.json");
    if !fs::symlink_metadata(&path)?.is_file() {
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

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("workbench-format-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn lease_excludes_another_host_and_releases_on_drop() {
        let root = root();
        let lease = StorageLease::acquire(&root).unwrap();
        assert!(StorageLease::acquire(&root).is_err());
        drop(lease);
        StorageLease::acquire(&root).unwrap();
        fs::remove_dir_all(root).unwrap();
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
            let error = StorageLease::acquire(&root)
                .err()
                .expect("legacy fixture must not be accepted or initialized");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
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
        assert!(StorageLease::acquire(&root).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy data");
        assert!(!root.join("storage-format.json").exists());
        fs::remove_file(&legacy).unwrap();
        StorageLease::acquire(&root).unwrap();
        for bytes in [
            b"{corrupt".as_slice(),
            b"{\"format_version\":1,\"storage_kind\":\"pi-acp-workbench\"}".as_slice(),
        ] {
            fs::write(root.join("storage-format.json"), bytes).unwrap();
            assert!(StorageLease::acquire(&root).is_err());
            assert_eq!(fs::read(root.join("storage-format.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
