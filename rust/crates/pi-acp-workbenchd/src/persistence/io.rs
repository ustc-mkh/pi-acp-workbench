//! Bounded, checksummed, versioned records shared by durable stores.
use super::FORMAT_VERSION;
use crate::domain::error::DomainError;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::{fs, io::AsyncReadExt};
const MAX_RECORD: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record<T> {
    format_version: u32,
    checksum: String,
    body: T,
}
fn checksum<T: Serialize>(body: &T) -> Result<String, DomainError> {
    let bytes =
        serde_json::to_vec(body).map_err(|error| DomainError::Persistence(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub async fn write<T: Serialize>(path: &Path, body: &T) -> Result<(), DomainError> {
    let parent = path
        .parent()
        .ok_or_else(|| DomainError::Persistence("record parent missing".into()))?;
    fs::create_dir_all(parent).await.map_err(failure)?;
    // Persist directory admission before publishing its first durable child.
    if let Some(ancestor) = parent.parent() {
        fs::File::open(ancestor)
            .await
            .map_err(failure)?
            .sync_all()
            .await
            .map_err(failure)?;
    }
    let record = Record {
        format_version: FORMAT_VERSION,
        checksum: checksum(body)?,
        body,
    };
    pi_acp_core::atomic::write_atomic_json(path, &record, true)
        .await
        .map_err(failure)
}
pub async fn read<T: DeserializeOwned + Serialize>(path: &Path) -> Result<Option<T>, DomainError> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error)),
    };
    let mut bytes = vec![];
    file.take(MAX_RECORD + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(failure)?;
    if bytes.len() as u64 > MAX_RECORD {
        return Err(DomainError::Persistence("record exceeds size limit".into()));
    }
    let record: Record<T> = serde_json::from_slice(&bytes)
        .map_err(|error| DomainError::Persistence(error.to_string()))?;
    if record.format_version != FORMAT_VERSION || record.checksum != checksum(&record.body)? {
        return Err(DomainError::Persistence(
            "record version/checksum mismatch".into(),
        ));
    }
    Ok(Some(record.body))
}
pub async fn remove(path: &Path) -> Result<(), DomainError> {
    match fs::remove_file(path).await {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                fs::File::open(parent)
                    .await
                    .map_err(failure)?
                    .sync_all()
                    .await
                    .map_err(failure)?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failure(error)),
    }
}
fn failure(error: std::io::Error) -> DomainError {
    DomainError::Persistence(error.to_string())
}
