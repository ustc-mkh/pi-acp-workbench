//! Immutable text/image BLOBs and entries; no independent payload files.
use super::database::{encode, StoreError};
use crate::domain::{
    fork::ContentHash,
    image::{ImageAsset, ImageRef},
    query::{
        ContentKind, ContentRef, ContentSlice, EntryHeader, QueryError, SafeInteger, TextBody,
        CONTENT_SLICE_BYTES, INLINE_TEXT_BYTES,
    },
    transcript::EntryRole,
    transition::{NewContent, NewEntry},
    EntryId, ProviderMessageId, TurnId,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "content_slice_tests.rs"]
mod slice_tests;

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
        None,
    )?;
    // Text can also be a durable notice/interaction/receipt or tool body.
    // Until each dedup identity has a safe expiry contract, retain it explicitly.
    db.execute(
        "INSERT OR IGNORE INTO archive_roots(content_id,reason) VALUES(?1,'text_archive')",
        [value.content.id.as_str()],
    )?;
    Ok(())
}
fn put(
    db: &Connection,
    id: &str,
    kind: &str,
    sha256: &str,
    data: &[u8],
    image: Option<&ImageRef>,
) -> Result<(), StoreError> {
    type Stored = (String, String, SafeInteger, Vec<u8>, Option<String>);
    let existing: Option<Stored> = db
        .query_row(
            "SELECT kind, sha256, bytes, data, image_ref_json FROM contents WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    if let Some((old_kind, hash, bytes, old_data, old_image)) = existing {
        let old_image: Option<ImageRef> = old_image
            .map(|encoded| serde_json::from_str(&encoded))
            .transpose()?;
        if old_kind != kind
            || old_image.as_ref() != image
            || hash != sha256
            || bytes.get() != data.len() as u64
            || old_data != data
        {
            return Err(StoreError::Conflict);
        }
        return Ok(());
    }
    db.execute(
        "INSERT INTO contents(id,kind,sha256,bytes,data,image_ref_json) VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            id,
            kind,
            sha256,
            data.len() as i64,
            data,
            image.map(encode).transpose()?
        ],
    )?;
    Ok(())
}
pub(super) fn put_image(db: &Connection, asset: &ImageAsset) -> Result<(), StoreError> {
    let image = asset.image();
    // ImageAsset constructors/deserializers already verify MIME signature/hash.
    put(
        db,
        image.id().as_str(),
        "Image",
        image.sha256(),
        asset.bytes(),
        Some(image),
    )
}
pub(super) fn image(
    db: &Connection,
    id: &crate::domain::ImageId,
) -> Result<ImageAsset, StoreError> {
    type Stored = (String, String, SafeInteger, Option<Vec<u8>>, Option<String>);
    // Bound BLOB materialization in SQL, including for externally corrupted
    // rows. Descriptors cannot authorize arbitrary paths or external fetches.
    let found: Option<Stored> = db.query_row(
        "SELECT kind,sha256,bytes,
         CASE WHEN kind='Image' AND bytes BETWEEN 1 AND 4194304 AND length(data)=bytes THEN data END,
         image_ref_json FROM contents WHERE id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional()?;
    let (kind, sha256, bytes, data, metadata) = found.ok_or(StoreError::NotFound)?;
    let image: ImageRef =
        serde_json::from_str(&metadata.ok_or(StoreError::Invalid("image descriptor missing"))?)?;
    if kind != "Image"
        || image.id() != id
        || image.sha256() != sha256
        || image.byte_len() != bytes.get()
    {
        return Err(StoreError::Invalid("image content identity mismatch"));
    }
    ImageAsset::from_archive(
        image,
        data.ok_or(StoreError::Invalid(
            "image BLOB length exceeds bound or mismatches",
        ))?,
    )
    .map_err(|_| StoreError::Invalid("invalid archived image bytes/MIME/hash"))
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
/// Bounded byte slices validate the descriptor and UTF-8 boundaries. The
/// returned whole-content hash is identity, NOT a proof of individual slices;
/// full byte/hash validation remains at immutable write/archive boundaries.
pub(super) fn slice(
    db: &Connection,
    content: &ContentRef,
    offset: SafeInteger,
    requested: Option<usize>,
) -> Result<ContentSlice, StoreError> {
    content.validate()?;
    let length = requested.unwrap_or(CONTENT_SLICE_BYTES);
    if length == 0 || length > CONTENT_SLICE_BYTES || offset > content.bytes {
        return Err(QueryError::InvalidInput.into());
    }
    type Stored = (String, String, SafeInteger, SafeInteger, Vec<u8>);
    let found: Option<Stored> = db
        .query_row(
            "SELECT kind,sha256,bytes,length(data),substr(data,?2,?3) FROM contents WHERE id=?1",
            params![content.id.as_str(), offset.get() as i64 + 1, length as i64],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let (kind, sha, bytes, actual_bytes, mut data) = found.ok_or(StoreError::NotFound)?;
    if kind != kind_name(content.kind)
        || sha != content.sha256.as_str()
        || bytes != content.bytes
        || actual_bytes != bytes
    {
        return Err(StoreError::Invalid("content reference identity mismatch"));
    }
    match std::str::from_utf8(&data) {
        Ok(_) => {}
        Err(error)
            if error.error_len().is_none() && offset.get() + (data.len() as u64) < bytes.get() =>
        {
            data.truncate(error.valid_up_to());
        }
        Err(_) => return Err(QueryError::InvalidInput.into()),
    }
    if data.is_empty() && offset < bytes {
        return Err(QueryError::TooLarge.into());
    }
    let next = offset.get() + data.len() as u64;
    let text =
        String::from_utf8(data).map_err(|_| StoreError::Invalid("content slice is not UTF-8"))?;
    Ok(ContentSlice {
        text,
        next_offset: (next < bytes.get())
            .then(|| SafeInteger::new(next))
            .transpose()?,
        sha256: content.sha256.clone(),
        total_bytes: bytes,
    })
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
