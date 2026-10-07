//! Atomic JSON replacement matching src/atomic-json.ts:
//! temp sibling `${file}.${uuid}.tmp` at 0600, durable writes fsync file + parent dir.
use serde::Serialize;
use std::fs::OpenOptions as StdOpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub async fn write_atomic_json<T: Serialize>(
    path: &Path,
    value: &T,
    durable: bool,
) -> io::Result<()> {
    let tmp: PathBuf = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        Uuid::new_v4()
    ));
    let body =
        serde_json::to_vec(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let result = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .await?;
        // mode() is tokio::fs::OpenOptions' own unix method — no trait import needed.
        file.write_all(&body).await?;
        if durable {
            file.sync_all().await?;
        }
        drop(file);
        tokio::fs::rename(&tmp, path).await?;
        if durable {
            if let Some(parent) = path.parent() {
                let dir = StdOpenOptions::new().read(true).open(parent)?;
                dir.sync_all()?;
            }
        }
        io::Result::Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}
