//! Short titles and their daemon-owned model preference. First-input-only, once
//! per session; failures retain a readable fallback without replaying the call.
use pi_acp_core::atomic::write_atomic_json;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TitleSettings {
    pub model: String,
}
pub struct TitleStore {
    file: PathBuf,
    value: RwLock<TitleSettings>,
}
impl TitleStore {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            value: RwLock::new(TitleSettings::default()),
        }
    }
    pub async fn initialize(&self) -> Result<(), String> {
        match tokio::fs::File::open(&self.file).await {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(4097)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 4096 {
                    return Err("标题模型配置过大".into());
                }
                let settings: TitleSettings =
                    serde_json::from_slice(&bytes).map_err(|_| "标题模型配置损坏，未覆盖原文件")?;
                validate_model(&settings.model)?;
                *self.value.write().await = settings;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(())
    }
    pub async fn get(&self) -> TitleSettings {
        self.value.read().await.clone()
    }
    pub async fn set(&self, model: &str) -> Result<TitleSettings, String> {
        validate_model(model)?;
        let mut current = self.value.write().await;
        let next = TitleSettings {
            model: model.into(),
        };
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(self.file.parent().ok_or("标题设置文件路径缺少父目录")?)
            .map_err(|e| e.to_string())?;
        write_atomic_json(&self.file, &next, true)
            .await
            .map_err(|e| e.to_string())?;
        *current = next.clone();
        Ok(next)
    }
}
fn validate_model(model: &str) -> Result<(), String> {
    if model.len() > 300
        || model.chars().any(char::is_control)
        || (!model.is_empty()
            && model != "off"
            && !model
                .split_once('/')
                .is_some_and(|(p, id)| !p.is_empty() && !id.is_empty()))
    {
        return Err("标题模型需要 provider/model 标识".into());
    }
    Ok(())
}
pub fn short_title(text: &str, limit: usize) -> String {
    let mut space = true;
    text.chars()
        .filter_map(|c| {
            let c = if c.is_whitespace() { ' ' } else { c };
            if c.is_control() || (c == ' ' && space) {
                return None;
            }
            space = c == ' ';
            Some(c)
        })
        .take(limit)
        .collect::<String>()
        .trim_end()
        .to_owned()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn persists_model_and_rejects_corruption_without_repair() {
        let root = std::env::temp_dir().join(format!("pi-title-{}", uuid::Uuid::new_v4()));
        let file = root.join("title.json");
        let store = TitleStore::new(file.clone());
        store.initialize().await.unwrap();
        assert_eq!(store.get().await.model, "");
        store.set("provider/model").await.unwrap();
        let next = TitleStore::new(file.clone());
        next.initialize().await.unwrap();
        assert_eq!(next.get().await.model, "provider/model");
        assert!(next.set("invalid").await.is_err());
        tokio::fs::write(&file, "broken").await.unwrap();
        assert!(TitleStore::new(file.clone()).initialize().await.is_err());
        assert_eq!(tokio::fs::read_to_string(file).await.unwrap(), "broken");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[test]
    fn short_titles_preserve_unicode_and_normalize_whitespace() {
        assert_eq!(short_title("  修复\n  模型 😀 标题 ", 8), "修复 模型 😀");
    }
}
