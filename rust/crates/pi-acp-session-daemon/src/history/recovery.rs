//! Startup-only reachability cleanup. Never run while runtime-only references
//! exist. Validate all live snapshots before deleting anything; corrupt evidence,
//! request receipts and tombstones are never repaired or expired automatically.
use super::*;
use tokio::io::AsyncReadExt;
impl SharedHistoryStore {
    pub async fn recover_orphans(&self) -> Result<(), String> {
        let _guard = self.transactions.lock().await;
        self.initialize().await?;
        // A missing index may be a lost/restoring backup, not an empty store.
        // Never infer that existing snapshots are disposable in that case.
        if !tokio::fs::try_exists(self.root.join("index.json"))
            .await
            .map_err(|e| e.to_string())?
        {
            if let Ok(mut files) = tokio::fs::read_dir(&self.conversations).await {
                if files
                    .next_entry()
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    return Err("历史索引缺失但快照仍存在，请从备份恢复；未清理文件。".into());
                }
            }
            return Ok(());
        }
        let index = self.index().await?;
        let mut snapshots = HashSet::new();
        let mut diffs = HashSet::new();
        for stub in &index.sessions {
            let file = self.snapshot_file(&Self::storage_key(stub)?);
            snapshots.insert(file.clone());
            let snapshot = if stub.stored == Some(true) {
                let mut text = String::new();
                tokio::fs::File::open(file)
                    .await
                    .map_err(|e| e.to_string())?
                    .take(512 * 1024 * 1024 + 1)
                    .read_to_string(&mut text)
                    .await
                    .map_err(|e| e.to_string())?;
                if text.len() > 512 * 1024 * 1024 {
                    return Err("历史文件超过恢复检查上限，未清理文件".into());
                }
                let snapshot: Snapshot =
                    serde_json::from_str(&text).map_err(|_| SNAPSHOT_MISMATCH.to_string())?;
                if snapshot.id != stub.id
                    || snapshot.revision != stub.revision
                    || snapshot.cwd != stub.cwd
                {
                    return Err(SNAPSHOT_MISMATCH.into());
                }
                validate_snapshot(snapshot)?
            } else {
                validate_snapshot(stub.clone())?
            };
            for entry in snapshot.entries {
                if let Some(diff) = entry.diff {
                    if let Some(key) = &diff.content_ref {
                        self.load_diff(&diff).await?;
                        diffs.insert(self.root.join("diffs").join(format!("{key}.json")));
                    }
                }
            }
        }
        for (directory, retained) in [
            (&self.conversations, &snapshots),
            (&self.root.join("diffs"), &diffs),
        ] {
            let mut files = match tokio::fs::read_dir(directory).await {
                Ok(files) => files,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.to_string()),
            };
            while let Some(file) = files.next_entry().await.map_err(|e| e.to_string())? {
                let name = file.file_name().to_string_lossy().into_owned();
                let known = name.strip_suffix(".json").is_some_and(|key| {
                    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
                });
                if known
                    && file.file_type().await.map_err(|e| e.to_string())?.is_file()
                    && !retained.contains(&file.path())
                {
                    tokio::fs::remove_file(file.path())
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preserves_evidence_on_invalid_index_then_collects_unreachable_blobs() {
        let root = std::env::temp_dir().join(format!("history-recovery-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(root.join("diffs")).await.unwrap();
        let orphan = root.join("diffs").join(format!("{}.json", "a".repeat(64)));
        tokio::fs::write(&orphan, "orphan").await.unwrap();
        let fresh = SharedHistoryStore::new(root.clone());
        fresh.recover_orphans().await.unwrap();
        assert!(orphan.exists());
        tokio::fs::write(root.join("index.json"), "broken")
            .await
            .unwrap();
        let store = SharedHistoryStore::new(root.clone());
        assert!(store.recover_orphans().await.is_err());
        assert!(orphan.exists());
        tokio::fs::write(root.join("index.json"), r#"{"sessions":[],"deleted":[]}"#)
            .await
            .unwrap();
        store.recover_orphans().await.unwrap();
        assert!(!orphan.exists());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
