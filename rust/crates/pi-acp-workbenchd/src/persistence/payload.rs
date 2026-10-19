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
    query::{
        ContentKind, ContentRef, ContentSlice, EntryHeader, SafeInteger, TextBody, MAX_QUERY_BYTES,
    },
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
pub(crate) fn history_delivery_id(
    bot: i64,
    topic: &crate::telegram::types::TopicKey,
    session: &crate::domain::SessionId,
    entry: &EntryId,
) -> Result<crate::domain::DeliveryId, DomainError> {
    let key = serde_json::to_string(&(bot, topic, session, entry)).map_err(failure)?;
    Ok(crate::domain::DeliveryId::new(format!(
        "history-{}",
        ContentHash::of(&key).as_str()
    ))?)
}
pub(crate) fn automatic_delivered(
    db: &Connection,
    bot: i64,
    topic: &crate::telegram::types::TopicKey,
    session: &crate::domain::SessionId,
    entry: &EntryId,
    seq: SafeInteger,
    turn: &crate::domain::TurnId,
) -> Result<bool, StoreError> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM telegram_turn_receipts r JOIN delivery_entries de ON de.delivery_id=r.delivery_id WHERE r.delivery_id=(CASE (SELECT role FROM entries WHERE entry_id=?7) WHEN 'User' THEN 'input-' || substr(?1,6) ELSE ?1 END) AND r.bot_id=?2 AND r.chat=?3 AND r.thread=?4 AND r.session=?5 AND de.seq=?6 AND de.entry_id=?7)", rusqlite::params![format!("turn-{turn}"), bot, topic.chat.get(), topic.thread.map_or(0, |thread| thread.get()), session.as_str(), seq, entry.as_str()], |row| row.get(0)).map_err(StoreError::from)
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
#[derive(Debug, Serialize)]
pub struct DeliveryPage {
    pub entries: Vec<EntryHeader>,
    pub next_seq: Option<SafeInteger>,
}

pub(super) enum Request {
    InputOrigin {
        operation: crate::domain::OperationId,
        bot: i64,
        topic: crate::telegram::types::TopicKey,
        session: crate::domain::SessionId,
        reply: Reply<bool>,
    },
    AutomaticDelivered {
        bot: i64,
        topic: crate::telegram::types::TopicKey,
        session: crate::domain::SessionId,
        entry: EntryId,
        seq: SafeInteger,
        turn: crate::domain::TurnId,
        reply: Reply<bool>,
    },
    HistoryDelivered {
        ids: Vec<crate::domain::DeliveryId>,
        reply: Reply<Vec<bool>>,
    },
    DeliveryPage {
        id: crate::domain::DeliveryId,
        after: SafeInteger,
        reply: Reply<DeliveryPage>,
    },
    Header {
        id: EntryId,
        reply: Reply<EntryHeader>,
    },
    Put {
        payload: Box<Payload>,
        reply: Reply<()>,
    },
    Notice {
        id: NoticeId,
        reply: Reply<Option<NoticeContent>>,
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
    pub async fn content_slice(
        &self,
        reference: &ContentRef,
        offset: SafeInteger,
    ) -> Result<ContentSlice, DomainError> {
        self.database
            .content_slice(reference.clone(), offset, None)
            .await
            .map_err(failure)
    }
    pub async fn delivery_page(
        &self,
        id: &crate::domain::DeliveryId,
        after: SafeInteger,
    ) -> Result<DeliveryPage, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::DeliveryPage {
            id: id.clone(),
            after,
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub(crate) async fn input_origin(
        &self,
        operation: crate::domain::OperationId,
        bot: i64,
        topic: crate::telegram::types::TopicKey,
        session: crate::domain::SessionId,
    ) -> Result<bool, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::InputOrigin {
            operation,
            bot,
            topic,
            session,
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub(crate) async fn automatic_delivered(
        &self,
        bot: i64,
        topic: &crate::telegram::types::TopicKey,
        session: &crate::domain::SessionId,
        entry: &EntryId,
        seq: SafeInteger,
        turn: &crate::domain::TurnId,
    ) -> Result<bool, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::AutomaticDelivered {
            bot,
            topic: topic.clone(),
            session: session.clone(),
            entry: entry.clone(),
            seq,
            turn: turn.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub(crate) async fn history_delivered(
        &self,
        ids: Vec<crate::domain::DeliveryId>,
    ) -> Result<Vec<bool>, DomainError> {
        if ids.len() > 100 {
            return Err(failure("history lookup budget exceeded"));
        }
        let (reply, result) = oneshot::channel();
        self.submit(Request::HistoryDelivered { ids, reply })
            .await?;
        result.await.map_err(failure)?.map_err(failure)
    }
    pub async fn entry_header(&self, id: &EntryId) -> Result<EntryHeader, DomainError> {
        let (reply, result) = oneshot::channel();
        self.submit(Request::Header {
            id: id.clone(),
            reply,
        })
        .await?;
        result.await.map_err(failure)?.map_err(failure)
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
        self.find_notice(id)
            .await?
            .ok_or_else(|| failure("notice payload missing"))
    }
    pub async fn find_notice(&self, id: &NoticeId) -> Result<Option<NoticeContent>, DomainError> {
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
fn delivery_page(
    db: &Connection,
    id: &crate::domain::DeliveryId,
    after: SafeInteger,
) -> Result<DeliveryPage, StoreError> {
    let (record, _) = super::delivery::record(db, id)?.ok_or(StoreError::NotFound)?;
    let crate::domain::transition::DeliveryPayload::Turn {
        turn,
        first_seq,
        last_seq,
        ..
    } = record.intent.payload
    else {
        return Err(StoreError::Invalid("delivery has no frozen turn manifest"));
    };
    let mut page = DeliveryPage {
        entries: Vec::new(),
        next_seq: None,
    };
    let mut statement = db.prepare("SELECT de.seq,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,CASE WHEN c.bytes<=16384 THEN c.data ELSE NULL END FROM delivery_entries de JOIN entries e ON e.entry_id=de.entry_id JOIN contents c ON c.id=e.content_id WHERE de.delivery_id=?1 AND de.seq>?2 ORDER BY de.seq LIMIT 101")?;
    let mut rows = statement.query(rusqlite::params![id.as_str(), after])?;
    while let Some(row) = rows.next()? {
        let header = content::header(row)?;
        if header.turn != turn
            || header.role != crate::domain::transcript::EntryRole::Agent
            || header.seq < first_seq
            || header.seq > last_seq
        {
            return Err(StoreError::Invalid(
                "frozen delivery entry identity mismatch",
            ));
        }
        if page.entries.len() == 100 {
            return Ok(page);
        }
        let previous = page.next_seq;
        page.next_seq = Some(header.seq);
        page.entries.push(header);
        if crate::domain::query::json_bytes(&page, MAX_QUERY_BYTES).is_err() {
            page.entries.pop();
            page.next_seq = previous;
            if page.entries.is_empty() {
                return Err(crate::domain::query::QueryError::TooLarge.into());
            }
            return Ok(page);
        }
    }
    page.next_seq = None;
    Ok(page)
}

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
pub(super) fn entry(db: &Connection, id: &EntryId) -> Result<TranscriptEntry, StoreError> {
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
pub(super) fn notice_optional(
    db: &Connection,
    id: NoticeId,
) -> Result<Option<NoticeContent>, StoreError> {
    match read(db, content_id("notice", id.as_str())?) {
        Ok(text) => Ok(Some(NoticeContent { id, text })),
        Err(StoreError::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
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
            let result = notice_optional(db, id);
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
        Request::InputOrigin {
            operation,
            bot,
            topic,
            session,
            reply,
        } => {
            let result = db.query_row("SELECT EXISTS(SELECT 1 FROM telegram_prompt_attempts p JOIN telegram_inbox i USING(bot_id,update_id) WHERE p.operation=?1 AND p.bot_id=?2 AND json_extract(i.command_json,'$.command.topic')=?3 AND coalesce(json_extract(i.command_json,'$.command.action.Prompt.session'),json_extract(i.command_json,'$.command.action.Control.Interrupt.session'))=?4)", rusqlite::params![operation.as_str(), bot, serde_json::to_string(&topic).map_err(|_| StoreError::Invalid("topic encoding")).unwrap_or_default(), session.as_str()], |row| row.get(0)).map_err(StoreError::from);
            let _ = reply.send(result);
        }
        Request::AutomaticDelivered {
            bot,
            topic,
            session,
            entry,
            seq,
            turn,
            reply,
        } => {
            let _ = reply.send(automatic_delivered(
                db, bot, &topic, &session, &entry, seq, &turn,
            ));
        }
        Request::HistoryDelivered { ids, reply } => {
            let result = (|| {
                if ids.len() > 100 {
                    return Err(StoreError::Invalid("history lookup budget exceeded"));
                }
                let mut statement = db.prepare("SELECT EXISTS(SELECT 1 FROM deliveries WHERE delivery_id=?1 AND status='Acked') OR EXISTS(SELECT 1 FROM telegram_history_exports x JOIN deliveries d ON d.delivery_id=x.delivery_id WHERE x.export_id=?1 AND d.status='Acked')")?;
                ids.iter()
                    .map(|id| {
                        statement
                            .query_row([id.as_str()], |row| row.get(0))
                            .map_err(StoreError::from)
                    })
                    .collect()
            })();
            let _ = reply.send(result);
        }
        Request::DeliveryPage { id, after, reply } => {
            let _ = reply.send(delivery_page(db, &id, after));
        }
        Request::Header { id, reply } => {
            let result = (|| {
                let mut statement = db.prepare("SELECT 0,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,CASE WHEN c.bytes<=16384 THEN c.data ELSE NULL END FROM entries e JOIN contents c ON c.id=e.content_id WHERE e.entry_id=?1")?;
                let mut rows = statement.query([id.as_str()])?;
                content::header(rows.next()?.ok_or(StoreError::NotFound)?)
            })();
            let _ = reply.send(result);
        }
        Request::Entry { id, reply } => {
            let _ = reply.send(entry(db, &id));
        }
    }
}
