//! Immutable, content-addressed Diff bodies. A durable blob always precedes its
//! reference. Legacy inline snapshots remain readable; no destructive migration.
use super::*;
use crate::types::TurnDiff;
use tokio::io::AsyncReadExt;
const MAX_DIFF_BYTES: u64 = 32 * 1024 * 1024;
impl SharedHistoryStore {
    pub async fn compact_diff(&self, diff: &mut TurnDiff) -> Result<(), String> {
        if diff.content_ref.is_some() || diff.files.is_empty() {
            return Ok(());
        }
        let text = serde_json::to_string(diff).map_err(|e| e.to_string())?;
        if text.len() as u64 > MAX_DIFF_BYTES {
            return Err("Diff 内容超过存储上限".into());
        }
        let key = sha256_hex(&text);
        let directory = self.root.join("diffs");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .map_err(|e| e.to_string())?;
        let file = directory.join(format!("{key}.json"));
        // Atomic writes use private files; never expose partially written blobs.
        if !tokio::fs::try_exists(&file)
            .await
            .map_err(|e| e.to_string())?
        {
            write_atomic_json(&file, diff, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        diff.content_ref = Some(key);
        for file in &mut diff.files {
            if (file.before.is_none() || file.after.is_none()) && file.omitted.is_none() {
                file.omitted = Some("未保存完整文本".into());
            }
            file.before = None;
            file.after = None;
            file.patch = None;
        }
        Ok(())
    }
    pub async fn compact_entries(&self, entries: &mut [crate::types::Entry]) -> Result<(), String> {
        for entry in entries {
            if let Some(diff) = &mut entry.diff {
                self.compact_diff(diff).await?;
            }
        }
        Ok(())
    }
    pub async fn load_diff(&self, summary: &TurnDiff) -> Result<TurnDiff, String> {
        let Some(key) = &summary.content_ref else {
            return Ok(summary.clone());
        };
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Diff 内容引用无效".into());
        }
        let file = tokio::fs::File::open(self.root.join("diffs").join(format!("{key}.json")))
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(MAX_DIFF_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_DIFF_BYTES {
            return Err("Diff 内容超过读取上限".into());
        }
        let diff: TurnDiff = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let canonical = serde_json::to_string(&diff).map_err(|e| e.to_string())?;
        if sha256_hex(&canonical) != *key || diff.content_ref.is_some() {
            return Err("Diff 内容校验失败".into());
        }
        Ok(diff)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn diff_content_roundtrip_and_corruption_fail_closed() {
        let root = std::env::temp_dir().join(format!("diff-store-{}", Uuid::new_v4()));
        let store = SharedHistoryStore::new(root.clone());
        let mut diff: TurnDiff = serde_json::from_value(serde_json::json!({"status":"complete","warnings":[],"files":[{"path":"one","status":"modified","before":"before","after":"after","patch":"patch","added":1,"removed":1}]})).unwrap();
        store.compact_diff(&mut diff).await.unwrap();
        assert!(diff.files[0].before.is_none());
        let full = store.load_diff(&diff).await.unwrap();
        assert_eq!(full.files[0].before.as_deref(), Some("before"));
        let key = diff.content_ref.clone().unwrap();
        tokio::fs::write(root.join("diffs").join(format!("{key}.json")), b"{}")
            .await
            .unwrap();
        assert!(store.load_diff(&diff).await.is_err());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
