//! Immutable delivery content survives session mutation/removal.
use super::io;
use crate::domain::{
    error::DomainError,
    ids::{EntryId, InteractionId, NoticeId},
    interaction::Interaction,
    transcript::TranscriptEntry,
};
use serde::{de::DeserializeOwned, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoticeContent {
    pub id: NoticeId,
    pub text: String,
}
#[derive(Clone)]
pub struct PayloadStore {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}
impl PayloadStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            gate: Arc::new(Mutex::new(())),
        }
    }
    async fn put<T: Serialize + DeserializeOwned>(
        &self,
        name: String,
        value: &T,
    ) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let path = self.root.join(name);
        if let Some(existing) = io::read::<T>(&path).await? {
            if serde_json::to_vec(&existing).map_err(failure)?
                != serde_json::to_vec(value).map_err(failure)?
            {
                return Err(DomainError::Persistence(
                    "immutable delivery payload changed".into(),
                ));
            }
            return Ok(());
        }
        io::write(&path, value).await
    }
    pub async fn put_image(
        &self,
        asset: &crate::domain::image::ImageAsset,
    ) -> Result<(), DomainError> {
        self.put(format!("image-{}.json", asset.image().id()), asset)
            .await
    }
    pub async fn image_by_id(
        &self,
        id: &crate::domain::ImageId,
    ) -> Result<crate::domain::image::ImageAsset, DomainError> {
        let asset: crate::domain::image::ImageAsset =
            io::read(&self.root.join(format!("image-{id}.json")))
                .await?
                .ok_or_else(|| DomainError::Persistence("image payload missing".into()))?;
        if asset.image().id() != id {
            return Err(DomainError::Persistence(
                "image payload identity mismatch".into(),
            ));
        }
        Ok(asset)
    }
    pub async fn image(
        &self,
        expected: &crate::domain::image::ImageRef,
    ) -> Result<crate::domain::image::ImageAsset, DomainError> {
        let asset = self.image_by_id(expected.id()).await?;
        if asset.image() != expected {
            return Err(DomainError::Persistence(
                "image payload identity mismatch".into(),
            ));
        }
        Ok(asset)
    }
    pub async fn put_notice(&self, notice: &NoticeContent) -> Result<(), DomainError> {
        self.put(format!("notice-{}.json", notice.id), notice).await
    }
    pub async fn notice(&self, id: &NoticeId) -> Result<NoticeContent, DomainError> {
        let notice: NoticeContent = io::read(&self.root.join(format!("notice-{id}.json")))
            .await?
            .ok_or_else(|| DomainError::Persistence("delivery notice missing".into()))?;
        if &notice.id != id {
            return Err(DomainError::Persistence(
                "delivery notice identity mismatch".into(),
            ));
        }
        Ok(notice)
    }
    pub async fn put_entry(&self, entry: &TranscriptEntry) -> Result<(), DomainError> {
        self.put(format!("entry-{}.json", entry.id), entry).await
    }
    pub async fn entry(&self, id: &EntryId) -> Result<TranscriptEntry, DomainError> {
        let entry: TranscriptEntry = io::read(&self.root.join(format!("entry-{id}.json")))
            .await?
            .ok_or_else(|| DomainError::Persistence("delivery entry missing".into()))?;
        if &entry.id != id {
            return Err(DomainError::Persistence(
                "delivery entry identity mismatch".into(),
            ));
        }
        Ok(entry)
    }
    pub async fn put_interaction(&self, interaction: &Interaction) -> Result<(), DomainError> {
        self.put(format!("interaction-{}.json", interaction.id), interaction)
            .await
    }
    pub async fn interaction(&self, id: &InteractionId) -> Result<Interaction, DomainError> {
        let interaction: Interaction = io::read(&self.root.join(format!("interaction-{id}.json")))
            .await?
            .ok_or_else(|| DomainError::Persistence("delivery interaction missing".into()))?;
        if &interaction.id != id {
            return Err(DomainError::Persistence(
                "delivery interaction identity mismatch".into(),
            ));
        }
        Ok(interaction)
    }
}
fn failure(error: serde_json::Error) -> DomainError {
    DomainError::Persistence(error.to_string())
}
