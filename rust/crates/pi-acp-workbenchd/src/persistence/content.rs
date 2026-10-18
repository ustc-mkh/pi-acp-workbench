//! Immutable text/image BLOBs and entries; no independent payload files.
use super::database::{encode, StoreError};
use crate::domain::{
    fork::ContentHash,
    image::{ImageAsset, ImageRef},
    query::{ContentKind, ContentRef, EntryHeader, SafeInteger, TextBody, INLINE_TEXT_BYTES},
    transcript::EntryRole,
    transition::{NewContent, NewEntry},
    EntryId, ProviderMessageId, TurnId,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub(super) fn kind_name(kind: ContentKind) -> &'static str {
    match kind {
        ContentKind::Text => "Text",
        ContentKind::ToolText => "ToolText",
        ContentKind::ToolDiff => "ToolDiff",
        ContentKind::ToolResource => "ToolResource",
    }
}
pub(super) fn role_name(role: &EntryRole) -> &'static str {
    match role {
        EntryRole::User => "User",
        EntryRole::Agent => "Agent",
        EntryRole::Thought => "Thought",
        EntryRole::Tool => "Tool",
    }
}
pub(super) fn put_text(db: &Connection, value: &NewContent) -> Result<(), StoreError> {
    value.validate()?;
    put(
        db,
        value.content.id.as_str(),
        kind_name(value.content.kind),
        value.content.sha256.as_str(),
        value.text.as_bytes(),
    )
}
fn put(db: &Connection, id: &str, kind: &str, sha256: &str, data: &[u8]) -> Result<(), StoreError> {
    type Stored = (String, String, SafeInteger, Vec<u8>);
    let existing: Option<Stored> = db
        .query_row(
            "SELECT kind, sha256, bytes, data FROM contents WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((old_kind, hash, bytes, old_data)) = existing {
        if old_kind != kind
            || hash != sha256
            || bytes.get() != data.len() as u64
            || old_data != data
        {
            return Err(StoreError::Conflict);
        }
        return Ok(());
    }
    db.execute(
        "INSERT INTO contents(id,kind,sha256,bytes,data) VALUES (?1,?2,?3,?4,?5)",
        params![id, kind, sha256, data.len() as i64, data],
    )?;
    Ok(())
}
fn put_image(db: &Connection, asset: &ImageAsset) -> Result<(), StoreError> {
    let image = asset.image();
    // ImageAsset constructors/deserializers already verify MIME signature/hash.
    put(
        db,
        image.id().as_str(),
        "Image",
        image.sha256(),
        asset.bytes(),
    )
}
pub(super) fn read_text(db: &Connection, content: &ContentRef) -> Result<String, StoreError> {
    content.validate()?;
    let found: Option<(String, String, SafeInteger, Vec<u8>)> = db
        .query_row(
            "SELECT kind,sha256,bytes,data FROM contents WHERE id = ?1",
            [content.id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (kind, sha, bytes, data) = found.ok_or(StoreError::NotFound)?;
    if kind != kind_name(content.kind)
        || sha != content.sha256.as_str()
        || bytes != content.bytes
        || data.len() as u64 != bytes.get()
    {
        return Err(StoreError::Invalid("content reference identity mismatch"));
    }
    let text =
        String::from_utf8(data).map_err(|_| StoreError::Invalid("content is not valid UTF-8"))?;
    if ContentHash::of(&text) != content.sha256 {
        return Err(StoreError::Invalid("immutable content hash mismatch"));
    }
    Ok(text)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryMetadata {
    id: EntryId,
    turn: TurnId,
    role: EntryRole,
    message: Option<ProviderMessageId>,
    text: ContentRef,
    image: Option<ImageRef>,
}
pub(super) fn put_entry(db: &Connection, entry: &NewEntry) -> Result<(), StoreError> {
    if entry.text.content.kind != ContentKind::Text {
        return Err(StoreError::Invalid("entry content is not text"));
    }
    put_text(db, &entry.text)?;
    if let Some(image) = &entry.image {
        put_image(db, image)?;
    }
    let metadata = EntryMetadata {
        id: entry.id.clone(),
        turn: entry.turn.clone(),
        role: entry.role.clone(),
        message: entry.message.clone(),
        text: entry.text.content.clone(),
        image: entry.image.as_ref().map(|asset| asset.image().clone()),
    };
    let encoded = encode(&metadata)?;
    let existing: Option<String> = db
        .query_row(
            "SELECT metadata_json FROM entries WHERE entry_id = ?1",
            [entry.id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        let decoded: EntryMetadata = serde_json::from_str(&existing)?;
        if encode(&decoded)? != encoded {
            return Err(StoreError::Conflict);
        }
        // Validate all redundant indexed identity fields on replay as on reads.
        let valid: bool = db.query_row("SELECT turn = ?2 AND role = ?3 AND message IS ?4 AND content_id = ?5 AND image_id IS ?6 FROM entries WHERE entry_id = ?1", params![entry.id.as_str(), entry.turn.as_str(), role_name(&entry.role), entry.message.as_ref().map(|v| v.as_str()), entry.text.content.id.as_str(), metadata.image.as_ref().map(|v| v.id().as_str())], |r| r.get(0))?;
        if !valid {
            return Err(StoreError::Invalid("entry identity mismatch"));
        }
        return Ok(());
    }
    db.execute("INSERT INTO entries(entry_id,turn,role,message,content_id,image_id,metadata_json) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![entry.id.as_str(), entry.turn.as_str(), role_name(&entry.role), entry.message.as_ref().map(|v| v.as_str()), entry.text.content.id.as_str(), metadata.image.as_ref().map(|v| v.id().as_str()), encoded])?;
    Ok(())
}
/// Columns match query::HISTORY_SQL. Large BLOBs are never fetched for headers.
pub(super) fn header(row: &Row<'_>) -> Result<EntryHeader, StoreError> {
    let seq: SafeInteger = row.get(0)?;
    let id: String = row.get(1)?;
    let turn: String = row.get(2)?;
    let role: String = row.get(3)?;
    let message: Option<String> = row.get(4)?;
    let content_id: String = row.get(5)?;
    let image_id: Option<String> = row.get(6)?;
    let metadata: EntryMetadata = serde_json::from_str(&row.get::<_, String>(7)?)?;
    let kind: String = row.get(8)?;
    let sha: String = row.get(9)?;
    let bytes: SafeInteger = row.get(10)?;
    metadata.text.validate()?;
    if metadata.id.as_str() != id
        || metadata.turn.as_str() != turn
        || role_name(&metadata.role) != role
        || metadata.message.as_ref().map(|v| v.as_str()) != message.as_deref()
        || metadata.text.id.as_str() != content_id
        || metadata.image.as_ref().map(|v| v.id().as_str()) != image_id.as_deref()
        || metadata.text.kind != ContentKind::Text
        || kind != "Text"
        || metadata.text.sha256.as_str() != sha
        || metadata.text.bytes != bytes
    {
        return Err(StoreError::Invalid("entry/content identity mismatch"));
    }
    let text = if bytes.get() <= INLINE_TEXT_BYTES as u64 {
        let raw: Vec<u8> = row.get(11)?;
        let text =
            String::from_utf8(raw).map_err(|_| StoreError::Invalid("entry text is not UTF-8"))?;
        TextBody::from_text(&text, metadata.text)?
    } else {
        TextBody::Archived {
            content: metadata.text,
        }
    };
    Ok(EntryHeader {
        seq,
        id: metadata.id,
        turn: metadata.turn,
        role: metadata.role,
        message: metadata.message,
        text,
        image: metadata.image,
    })
}
