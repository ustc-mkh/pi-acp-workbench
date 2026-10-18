//! Typed session transactions and indexed bounded queries; called only by the DB executor.
use super::{
    content,
    database::{encode, SessionCommit, StoreError},
};
use crate::domain::{query::*, transition::DeliveryIntent, Harness, SessionId};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub(super) const HISTORY_SQL: &str = "SELECT se.seq,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,CASE WHEN c.bytes <= 16384 THEN c.data ELSE NULL END FROM session_entries se JOIN entries e ON e.entry_id = se.entry_id JOIN contents c ON c.id = e.content_id WHERE se.session = ?1 AND se.seq <= ?2 AND se.seq < ?3 ORDER BY se.seq DESC LIMIT ?4";
pub(super) fn next_counter(db: &Connection, name: &str) -> Result<SafeInteger, StoreError> {
    let value: Option<SafeInteger> = db.query_row("UPDATE store_meta SET value = value + 1 WHERE key = ?1 AND value < 9007199254740991 RETURNING value", [name], |r| r.get(0)).optional()?;
    value.ok_or(StoreError::Invalid("database sequence exhausted"))
}
fn harness_name(harness: &Harness) -> &'static str {
    match harness {
        Harness::Pi => "Pi",
        Harness::Codex => "Codex",
        Harness::Claude => "Claude",
    }
}
fn parse_harness(value: &str) -> Result<Harness, StoreError> {
    match value {
        "Pi" => Ok(Harness::Pi),
        "Codex" => Ok(Harness::Codex),
        "Claude" => Ok(Harness::Claude),
        _ => Err(StoreError::Invalid("invalid harness")),
    }
}
fn summary(view: &SessionView, created_seq: SafeInteger) -> SessionSummary {
    SessionSummary {
        id: view.id.clone(),
        harness: view.harness.clone(),
        cwd: view.cwd.clone(),
        status: view.status.clone(),
        revision: view.revision,
        created_seq,
    }
}
pub(super) fn create(
    db: &mut Connection,
    view: &SessionView,
) -> Result<SessionSummary, StoreError> {
    view.validate()?;
    if view.revision.get() != 0 || view.last_entry_seq.get() != 0 {
        return Err(StoreError::Invalid(
            "new session must have zero revision/history",
        ));
    }
    let tx = db.transaction()?;
    let created = next_counter(&tx, "created_seq")?;
    tx.execute("INSERT INTO sessions(id,created_seq,revision,last_entry_seq,harness,cwd,status_json,hot_state_json) VALUES (?1,?2,0,0,?3,?4,?5,?6)", params![view.id.as_str(), created, harness_name(&view.harness), view.cwd.as_str(), encode(&view.status)?, encode(view)?])?;
    tx.commit()?;
    Ok(summary(view, created))
}
pub(super) fn view(db: &Connection, session: &SessionId) -> Result<SessionView, StoreError> {
    let mut statement = db.prepare("SELECT hot_state_json,revision,last_entry_seq,harness,cwd,status_json FROM sessions WHERE id = ?1")?;
    let mut rows = statement.query([session.as_str()])?;
    let row = rows.next()?.ok_or(StoreError::NotFound)?;
    let view: SessionView = serde_json::from_str(&row.get::<_, String>(0)?)?;
    view.validate()?;
    if &view.id != session
        || view.revision != row.get::<_, SafeInteger>(1)?
        || view.last_entry_seq != row.get::<_, SafeInteger>(2)?
        || harness_name(&view.harness) != row.get::<_, String>(3)?
        || view.cwd.as_str() != row.get::<_, String>(4)?
        || encode(&view.status)? != row.get::<_, String>(5)?
    {
        return Err(StoreError::Invalid("session identity/revision mismatch"));
    }
    Ok(view)
}
pub(super) fn commit(
    db: &mut Connection,
    commit: SessionCommit,
) -> Result<CommitBatch, StoreError> {
    let tx = db.transaction()?;
    let batch = apply_commit(&tx, &commit)?;
    tx.commit()?;
    Ok(batch)
}
pub(super) fn apply_commit(
    tx: &Transaction<'_>,
    commit: &SessionCommit,
) -> Result<CommitBatch, StoreError> {
    commit.next.validate()?;
    let old = view(tx, &commit.next.id)?;
    if old.revision != commit.expected_revision
        || commit.next.revision != commit.expected_revision.next()?
    {
        return Err(StoreError::Conflict);
    }
    if old.cwd != commit.next.cwd || old.harness != commit.next.harness {
        return Err(StoreError::Invalid("session immutable scope changed"));
    }
    let last = old
        .last_entry_seq
        .get()
        .checked_add(commit.append.len() as u64)
        .ok_or(StoreError::Invalid("entry sequence exhausted"))?;
    if commit.next.last_entry_seq != SafeInteger::new(last)? {
        return Err(StoreError::Invalid("next entry sequence mismatch"));
    }
    let changed = tx.execute("UPDATE sessions SET revision = ?2,last_entry_seq = ?3,status_json = ?4,hot_state_json = ?5 WHERE id = ?1 AND revision = ?6", params![commit.next.id.as_str(), commit.next.revision, commit.next.last_entry_seq, encode(&commit.next.status)?, encode(&commit.next)?, commit.expected_revision])?;
    if changed != 1 {
        return Err(StoreError::Conflict);
    }
    for item in &commit.contents {
        content::put_text(tx, item)?;
    }
    let mut entries = Vec::with_capacity(commit.append.len());
    for (index, entry) in commit.append.iter().enumerate() {
        content::put_entry(tx, entry)?;
        let seq = SafeInteger::new(old.last_entry_seq.get() + index as u64 + 1)?;
        tx.execute(
            "INSERT INTO session_entries(session,seq,entry_id) VALUES (?1,?2,?3)",
            params![commit.next.id.as_str(), seq, entry.id.as_str()],
        )?;
        entries.push(EntryHeader {
            seq,
            id: entry.id.clone(),
            turn: entry.turn.clone(),
            role: entry.role.clone(),
            message: entry.message.clone(),
            text: TextBody::from_text(&entry.text.text, entry.text.content.clone())?,
            image: entry.image.as_ref().map(|asset| asset.image().clone()),
        });
    }
    for update in &commit.tool_updates {
        update.header.validate()?;
        for item in &update.contents {
            content::put_text(tx, item)?;
        }
        validate_tool_refs(tx, &update.header)?;
        tx.execute("INSERT INTO tools(session,turn,tool_id,header_json) VALUES (?1,?2,?3,?4) ON CONFLICT(session,turn,tool_id) DO UPDATE SET header_json=excluded.header_json", params![commit.next.id.as_str(), update.header.turn.as_str(), update.header.id.as_str(), encode(&update.header)?])?;
    }
    for delivery in &commit.deliveries {
        if delivery.revision != commit.next.revision
            || delivery.target
                != (crate::domain::transition::DeliveryTarget::Session {
                    session: commit.next.id.clone(),
                    cwd: commit.next.cwd.clone(),
                })
        {
            return Err(StoreError::Invalid(
                "session delivery scope/revision mismatch",
            ));
        }
        put_delivery(tx, delivery)?;
    }
    let batch = CommitBatch {
        session: commit.next.id.clone(),
        revision: commit.next.revision,
        view: commit.view_changed.then(|| commit.next.clone()),
        entries,
        tools: commit
            .tool_updates
            .iter()
            .map(|update| update.header.clone())
            .collect(),
        removed: false,
    };
    batch.validate()?;
    Ok(batch)
}
fn validate_tool_refs(db: &Connection, header: &ToolHeader) -> Result<(), StoreError> {
    let check = |r: &ContentRef| -> Result<(), StoreError> {
        let found: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM contents WHERE id=?1 AND kind=?2 AND sha256=?3 AND bytes=?4)", params![r.id.as_str(), content::kind_name(r.kind), r.sha256.as_str(), r.bytes], |row| row.get(0))?;
        if !found {
            return Err(StoreError::Invalid("tool content reference mismatch"));
        }
        Ok(())
    };
    for body in &header.content {
        match body {
            ToolBody::Text { content } | ToolBody::ResourceText { content, .. } => check(content)?,
            ToolBody::Diff {
                old_text, new_text, ..
            } => {
                if let Some(r) = old_text {
                    check(r)?;
                }
                check(new_text)?;
            }
            _ => {}
        }
    }
    Ok(())
}
pub(super) fn put_delivery(db: &Connection, intent: &DeliveryIntent) -> Result<(), StoreError> {
    super::delivery::validate_intent(intent)?;
    let target = encode(&intent.target)?;
    let payload = encode(&intent.payload)?;
    if let Some((old, _)) = super::delivery::record(db, &intent.id)? {
        if old.intent.revision != intent.revision
            || (encode(&old.intent.target)?, encode(&old.intent.payload)?) != (target, payload)
        {
            return Err(StoreError::Conflict);
        }
        return Ok(());
    }
    let key = super::delivery::target_key(&intent.target);
    let order = next_counter(db, "delivery_seq")?;
    db.execute("INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status) VALUES (?1,?2,?3,?4,?5,?6,'Pending')", params![intent.id.as_str(), order, intent.revision, key, target, payload])?;
    Ok(())
}
pub(super) fn list(
    db: &Connection,
    cursor: Option<ListCursor>,
    requested: Option<usize>,
) -> Result<ListPage, StoreError> {
    QueryCommand::List {
        cursor: cursor.clone(),
        limit: requested,
    }
    .validate()?;
    let limit = limit(requested, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)?;
    let high: SafeInteger = db.query_row(
        "SELECT value FROM store_meta WHERE key='created_seq'",
        [],
        |r| r.get(0),
    )?;
    let max = match &cursor {
        Some(c) if c.max_created_seq > high => return Err(QueryError::InvalidInput.into()),
        Some(c) => c.max_created_seq,
        None => high,
    };
    let before = cursor
        .as_ref()
        .map_or(MAX_SAFE_INTEGER + 1, |c| c.before_seq.get());
    let mut statement = db.prepare("SELECT id,harness,cwd,status_json,revision,created_seq FROM sessions WHERE created_seq <= ?1 AND created_seq < ?2 ORDER BY created_seq DESC LIMIT ?3")?;
    let mut rows = statement.query(params![max, before as i64, (limit + 1) as i64])?;
    let mut page = ListPage {
        sessions: vec![],
        next_cursor: None,
    };
    let mut more = false;
    while let Some(row) = rows.next()? {
        if page.sessions.len() == limit {
            more = true;
            break;
        }
        let item = SessionSummary {
            id: SessionId::new(row.get::<_, String>(0)?)
                .map_err(|_| StoreError::Invalid("invalid summary id"))?,
            harness: parse_harness(&row.get::<_, String>(1)?)?,
            cwd: crate::domain::WorkspacePath::new(row.get::<_, String>(2)?)
                .map_err(|_| StoreError::Invalid("invalid summary cwd"))?,
            status: serde_json::from_str(&row.get::<_, String>(3)?)?,
            revision: row.get(4)?,
            created_seq: row.get(5)?,
        };
        page.sessions.push(item);
        page.next_cursor = Some(ListCursor {
            version: ProtocolVersion,
            max_created_seq: max,
            before_seq: page.sessions.last().expect("pushed item").created_seq,
        });
        if page.validate().is_err() {
            page.sessions.pop();
            if page.sessions.is_empty() {
                return Err(QueryError::TooLarge.into());
            }
            more = true;
            break;
        }
    }
    page.next_cursor = if more {
        Some(ListCursor {
            version: ProtocolVersion,
            max_created_seq: max,
            before_seq: page.sessions.last().expect("nonempty page").created_seq,
        })
    } else {
        None
    };
    page.validate()?;
    Ok(page)
}
pub(super) fn history(
    db: &Connection,
    session: &SessionId,
    cursor: Option<HistoryCursor>,
    requested: Option<usize>,
) -> Result<HistoryPage, StoreError> {
    QueryCommand::History {
        session: session.clone(),
        cursor: cursor.clone(),
        limit: requested,
    }
    .validate()?;
    let limit = limit(requested, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)?;
    let high: SafeInteger = db
        .query_row(
            "SELECT last_entry_seq FROM sessions WHERE id=?1",
            [session.as_str()],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(StoreError::NotFound)?;
    let max = match &cursor {
        Some(c) if c.max_entry_seq > high => return Err(QueryError::InvalidInput.into()),
        Some(c) => c.max_entry_seq,
        None => high,
    };
    let before = cursor
        .as_ref()
        .map_or(MAX_SAFE_INTEGER + 1, |c| c.before_seq.get());
    let mut statement = db.prepare(HISTORY_SQL)?;
    let mut rows = statement.query(params![
        session.as_str(),
        max,
        before as i64,
        (limit + 1) as i64
    ])?;
    let mut page = HistoryPage {
        entries: vec![],
        next_cursor: None,
    };
    let mut more = false;
    while let Some(row) = rows.next()? {
        if page.entries.len() == limit {
            more = true;
            break;
        }
        page.entries.push(content::header(row)?);
        page.next_cursor = Some(HistoryCursor {
            version: ProtocolVersion,
            session: session.clone(),
            max_entry_seq: max,
            before_seq: page.entries.last().expect("pushed row").seq,
        });
        if page.validate().is_err() {
            page.entries.pop();
            if page.entries.is_empty() {
                return Err(QueryError::TooLarge.into());
            }
            more = true;
            break;
        }
    }
    page.next_cursor = if more {
        Some(HistoryCursor {
            version: ProtocolVersion,
            session: session.clone(),
            max_entry_seq: max,
            before_seq: page.entries.last().expect("nonempty page").seq,
        })
    } else {
        None
    };
    page.entries.reverse();
    page.validate()?;
    Ok(page)
}
