//! Immutable delivery content in the host's sole SQLite database.
use super::{
    content,
    database::{encode, Database, StoreError, StoreRequest},
};
use crate::domain::{
    error::DomainError,
    fork::ContentHash,
    ids::{ContentId, EntryId, InteractionId, NoticeId},
    interaction::Interaction,
    query::{ContentKind, ContentRef, SafeInteger, TextBody},
    transcript::TranscriptEntry,
    transition::{NewContent, NewEntry},
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoticeContent {
    pub id: NoticeId,
    pub text: String,
}
#[derive(Clone)]
pub struct PayloadStore {
    database: Database,
}
type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum Payload {
    Notice(NoticeContent),
    Interaction(Interaction),
    Entry(TranscriptEntry),
}
pub(super) enum Request {
    Put {
        payload: Box<Payload>,
        reply: Reply<()>,
    },
    Notice {
        id: NoticeId,
        reply: Reply<NoticeContent>,
    },
    Interaction {
        id: InteractionId,
        reply: Reply<Interaction>,
    },
    Entry {
        id: EntryId,
        reply: Reply<TranscriptEntry>,
    },
}
impl PayloadStore {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
    async fn submit(&self, request: Request) -> Result<(), DomainError> {
        self.database
            .enqueue(StoreRequest::Payload(Box::new(request)))
            .await
            .map_err(failure)
    }
    async fn put(&self, payload: Payload) -> Result<(), DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Put {
            payload: Box::new(payload),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub async fn put_image(
        &self,
        asset: &crate::domain::image::ImageAsset,
    ) -> Result<(), DomainError> {
        self.database
            .archive_image(asset.clone())
            .await
            .map_err(failure)
    }
    pub async fn image_by_id(
        &self,
        id: &crate::domain::ImageId,
    ) -> Result<crate::domain::image::ImageAsset, DomainError> {
        self.database.image_by_id(id.clone()).await.map_err(failure)
    }
    pub async fn image(
        &self,
        expected: &crate::domain::image::ImageRef,
    ) -> Result<crate::domain::image::ImageAsset, DomainError> {
        let asset = self.image_by_id(expected.id()).await?;
        if asset.image() != expected {
            return Err(failure("image payload identity mismatch"));
        }
        Ok(asset)
    }
    pub fn notice_ref(notice: &NoticeContent) -> Result<ContentRef, DomainError> {
        notice_content(notice)
            .map(|value| value.content)
            .map_err(failure)
    }
    pub async fn content(&self, reference: &ContentRef) -> Result<String, DomainError> {
        self.database
            .content(reference.clone())
            .await
            .map_err(failure)
    }
    pub async fn put_notice(&self, notice: &NoticeContent) -> Result<(), DomainError> {
        self.put(Payload::Notice(notice.clone())).await
    }
    pub async fn notice(&self, id: &NoticeId) -> Result<NoticeContent, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Notice {
            id: id.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub async fn put_entry(&self, entry: &TranscriptEntry) -> Result<(), DomainError> {
        self.put(Payload::Entry(entry.clone())).await
    }
    pub async fn entry(&self, id: &EntryId) -> Result<TranscriptEntry, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Entry {
            id: id.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub async fn put_interaction(&self, interaction: &Interaction) -> Result<(), DomainError> {
        self.put(Payload::Interaction(interaction.clone())).await
    }
    pub async fn interaction(&self, id: &InteractionId) -> Result<Interaction, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Interaction {
            id: id.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    #[cfg(test)]
    pub(crate) async fn shutdown(&self) {
        self.database.shutdown().await.unwrap();
    }
}
fn failure(error: impl std::fmt::Display) -> DomainError {
    DomainError::Persistence(error.to_string())
}
// Hashing the typed identity keeps all valid 200-byte IDs representable after
// namespacing. Scope is part of the key, so notice/interaction/entry IDs cannot
// alias one another. These are database keys, never filesystem paths.
pub(super) fn content_id(scope: &str, id: &str) -> Result<ContentId, StoreError> {
    ContentId::new(format!(
        "archive-{scope}-{:x}",
        Sha256::digest(id.as_bytes())
    ))
    .map_err(|_| StoreError::Invalid("invalid archive content id"))
}
pub(super) fn notice_content(notice: &NoticeContent) -> Result<NewContent, StoreError> {
    text(
        content_id("notice", notice.id.as_str())?,
        notice.text.clone(),
    )
}
pub(super) fn interaction_content(interaction: &Interaction) -> Result<NewContent, StoreError> {
    interaction
        .validate_definition()
        .map_err(|_| StoreError::Invalid("invalid archived interaction"))?;
    text(
        content_id("interaction", interaction.id.as_str())?,
        encode(interaction)?,
    )
}
pub(super) fn entry_content(entry: &TranscriptEntry) -> Result<NewContent, StoreError> {
    text(content_id("entry", entry.id.as_str())?, entry.text.clone())
}
fn text(id: ContentId, text: String) -> Result<NewContent, StoreError> {
    let content = NewContent {
        content: ContentRef {
            id,
            sha256: ContentHash::of(&text),
            bytes: SafeInteger::new(text.len() as u64)?,
            kind: ContentKind::Text,
        },
        text,
    };
    content.validate()?;
    Ok(content)
}
fn read(db: &Connection, id: ContentId) -> Result<String, StoreError> {
    let found: Option<(String, SafeInteger)> = db
        .query_row(
            "SELECT sha256,bytes FROM contents WHERE id=?1 AND kind='Text'",
            [id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (sha256, bytes) = found.ok_or(StoreError::NotFound)?;
    let sha256 = ContentHash::try_from(sha256)
        .map_err(|_| StoreError::Invalid("invalid archive content hash"))?;
    content::read_text(
        db,
        &ContentRef {
            id,
            sha256,
            bytes,
            kind: ContentKind::Text,
        },
    )
}
fn put(db: &Connection, payload: Payload) -> Result<(), StoreError> {
    match payload {
        Payload::Notice(notice) => content::put_text(db, &notice_content(&notice)?),
        Payload::Interaction(interaction) => {
            content::put_text(db, &interaction_content(&interaction)?)
        }
        Payload::Entry(entry) => {
            let image = entry
                .image
                .as_ref()
                .map(|expected| {
                    let asset = content::image(db, expected.id())?;
                    if asset.image() != expected {
                        return Err(StoreError::Invalid("entry image reference mismatch"));
                    }
                    Ok(asset)
                })
                .transpose()?;
            let text = entry_content(&entry)?;
            content::put_entry(
                db,
                &NewEntry {
                    id: entry.id,
                    turn: entry.turn,
                    role: entry.role,
                    message: entry.message,
                    text,
                    image,
                },
            )
        }
    }
}
fn entry(db: &Connection, id: &EntryId) -> Result<TranscriptEntry, StoreError> {
    let mut statement = db.prepare("SELECT 1,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,CASE WHEN c.bytes<=16384 THEN c.data ELSE NULL END FROM entries e JOIN contents c ON c.id=e.content_id WHERE e.entry_id=?1")?;
    let mut rows = statement.query([id.as_str()])?;
    let header = content::header(rows.next()?.ok_or(StoreError::NotFound)?)?;
    let text = match header.text {
        TextBody::Inline { text } => text,
        TextBody::Archived { content: reference } => content::read_text(db, &reference)?,
    };
    Ok(TranscriptEntry {
        id: header.id,
        turn: header.turn,
        role: header.role,
        message: header.message,
        text,
        image: header.image,
    })
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    match request {
        Request::Put { payload, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = db.transaction()?;
                put(&tx, *payload)?;
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        Request::Notice { id, reply } => {
            let result = content_id("notice", id.as_str())
                .and_then(|key| read(db, key))
                .map(|text| NoticeContent { id, text });
            let _ = reply.send(result);
        }
        Request::Interaction { id, reply } => {
            let result = (|| -> Result<Interaction, StoreError> {
                let interaction: Interaction =
                    serde_json::from_str(&read(db, content_id("interaction", id.as_str())?)?)?;
                if interaction.id != id {
                    return Err(StoreError::Invalid("interaction payload identity mismatch"));
                }
                Ok(interaction)
            })();
            let _ = reply.send(result);
        }
        Request::Entry { id, reply } => {
            let _ = reply.send(entry(db, &id));
        }
    }
}
