//! Typed session transactions and indexed bounded queries; called only by the DB executor.
use super::{
    content,
    database::{encode, StoreError},
};
use crate::domain::{
    query::*,
    transition::{DeliveryIntent, Transition},
    Harness, SessionId,
};
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
pub(super) fn summary(view: &SessionView, created_seq: SafeInteger) -> SessionSummary {
    SessionSummary {
        title: None,
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
    let created = insert_view(&tx, view)?;
    tx.commit()?;
    Ok(summary(view, created))
}
pub(super) fn insert_view(db: &Connection, view: &SessionView) -> Result<SafeInteger, StoreError> {
    view.validate()?;
    let removed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM removed_sessions WHERE id=?1)",
        [view.id.as_str()],
        |row| row.get(0),
    )?;
    if removed {
        return Err(StoreError::Conflict);
    }
    let created = next_counter(db, "created_seq")?;
    let activity = next_counter(db, "activity_seq")?;
    db.execute("INSERT INTO sessions(id,created_seq,activity_seq,revision,last_entry_seq,harness,cwd,status_json,hot_state_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![view.id.as_str(), created, activity, view.revision, view.last_entry_seq, harness_name(&view.harness), view.cwd.as_str(), encode(&view.status)?, encode(view)?])?;
    Ok(created)
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
pub(super) fn commit(db: &mut Connection, commit: Transition) -> Result<CommitBatch, StoreError> {
    let tx = db.transaction()?;
    let batch = apply_commit(&tx, &commit)?;
    tx.commit()?;
    Ok(batch)
}
pub(super) fn apply_commit(
    tx: &Transaction<'_>,
    commit: &Transition,
) -> Result<CommitBatch, StoreError> {
    commit.next.validate()?;
    let old = view(tx, &commit.next.id)?;
    if old.revision != commit.expected_revision
        || commit.next.revision != commit.expected_revision.next()?
    {
        return Err(StoreError::Conflict);
    }
    if old.cwd != commit.next.cwd
        || old.harness != commit.next.harness
        || encode(&old.origin)? != encode(&commit.next.origin)?
    {
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
    let activity = next_counter(tx, "activity_seq")?;
    let changed = tx.execute("UPDATE sessions SET activity_seq=?2,revision = ?3,last_entry_seq = ?4,status_json = ?5,hot_state_json = ?6 WHERE id = ?1 AND revision = ?7", params![commit.next.id.as_str(), activity, commit.next.revision, commit.next.last_entry_seq, encode(&commit.next.status)?, encode(&commit.next)?, commit.expected_revision])?;
    if changed != 1 {
        return Err(StoreError::Conflict);
    }
    super::management::observe(tx, &old, commit)?;
    let batch = apply_records(tx, commit, old.last_entry_seq)?;
    if let Some(operation) = &commit.operation {
        super::journal::finish_in_transaction(
            tx,
            operation,
            &Ok(CommandReceipt::Accepted {
                session: batch.session.clone(),
                revision: batch.revision,
            }),
        )
        .map_err(|error| StoreError::Io(error.to_string()))?;
    }
    Ok(batch)
}
pub(super) fn apply_records(
    tx: &Transaction<'_>,
    commit: &Transition,
    previous_entry_seq: SafeInteger,
) -> Result<CommitBatch, StoreError> {
    for item in &commit.contents {
        content::put_text(tx, item)?;
    }
    let batch = commit.batch(previous_entry_seq)?;
    for (entry, header) in commit.append.iter().zip(&batch.entries) {
        content::put_entry(tx, entry)?;
        tx.execute(
            "INSERT INTO session_entries(session,seq,entry_id) VALUES (?1,?2,?3)",
            params![commit.next.id.as_str(), header.seq, entry.id.as_str()],
        )?;
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
    if let crate::domain::transition::DeliveryPayload::HistoryEntry { session, entries } =
        &intent.payload
    {
        let crate::domain::transition::DeliveryTarget::Telegram {
            bot_id,
            chat,
            thread,
            ..
        } = &intent.target
        else {
            return Err(StoreError::Invalid(
                "history export requires Telegram target",
            ));
        };
        for (entry, _) in entries {
            let export = super::payload::history_delivery_id(
                *bot_id,
                &crate::telegram::types::TopicKey {
                    chat: crate::telegram::types::ChatId::new(*chat)
                        .map_err(|_| StoreError::Invalid("invalid history chat"))?,
                    thread: if *thread == 0 {
                        None
                    } else {
                        Some(
                            crate::telegram::types::TopicId::new(*thread)
                                .map_err(|_| StoreError::Invalid("invalid history thread"))?,
                        )
                    },
                },
                session,
                entry,
            )
            .map_err(|_| StoreError::Invalid("invalid history identity"))?;
            db.execute(
                "INSERT INTO telegram_history_exports(export_id,delivery_id) VALUES (?1,?2)",
                params![export.as_str(), intent.id.as_str()],
            )?;
        }
    }
    if let crate::domain::transition::DeliveryPayload::Turn {
        session,
        turn,
        first_seq,
        last_seq,
    } = &intent.payload
    {
        let source = view(db, session)?;
        if source.revision != intent.revision || last_seq > &source.last_entry_seq {
            return Err(StoreError::Conflict);
        }
        // Freeze links, not bodies, before the owning transaction can commit.
        // The turn index avoids walking historical entries; the session+entry
        // unique index then proves that each candidate belongs to this source.
        db.execute("INSERT INTO delivery_entries(delivery_id,seq,entry_id) SELECT ?1,se.seq,e.entry_id FROM entries e INDEXED BY entries_turn_role JOIN session_entries se ON se.session=?2 AND se.entry_id=e.entry_id WHERE e.turn=?3 AND e.role='Agent' AND se.seq BETWEEN ?4 AND ?5 ORDER BY se.seq", params![intent.id.as_str(), session.as_str(), turn.as_str(), first_seq, last_seq])?;
    }
    if let crate::domain::transition::DeliveryPayload::Input {
        session,
        entry,
        seq,
        ..
    } = &intent.payload
    {
        let inserted = db.execute("INSERT INTO delivery_entries(delivery_id,seq,entry_id) SELECT ?1,se.seq,e.entry_id FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?2 AND se.seq=?3 AND e.entry_id=?4 AND e.role='User'", params![intent.id.as_str(), session.as_str(), seq, entry.as_str()])?;
        if inserted != 1 {
            return Err(StoreError::Invalid("input manifest identity mismatch"));
        }
    }
    Ok(())
}
pub(super) fn tool(
    db: &Connection,
    session: &SessionId,
    turn: &crate::domain::TurnId,
    id: &crate::domain::ToolCallId,
) -> Result<Option<ToolHeader>, StoreError> {
    let encoded: Option<String> = db
        .query_row(
            "SELECT header_json FROM tools WHERE session=?1 AND turn=?2 AND tool_id=?3",
            params![session.as_str(), turn.as_str(), id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let header: Option<ToolHeader> = encoded
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    if let Some(header) = &header {
        header.validate()?;
        if &header.turn != turn || &header.id != id {
            return Err(StoreError::Invalid("tool identity mismatch"));
        }
        validate_tool_refs(db, header)?;
    }
    Ok(header)
}

pub(super) fn remove(
    db: &mut Connection,
    session: &SessionId,
    operation: Option<&crate::domain::operation::OperationTicket>,
) -> Result<CommitBatch, StoreError> {
    let tx = db.transaction()?;
    let current = view(&tx, session)?;
    if current.active_turn.is_some() {
        return Err(StoreError::Invalid("cannot remove an active turn"));
    }
    let revision = current.revision.next()?;
    tx.execute(
        "INSERT INTO removed_sessions(id,revision) VALUES (?1,?2)",
        params![session.as_str(), revision],
    )?;
    tx.execute("DELETE FROM tools WHERE session=?1", [session.as_str()])?;
    tx.execute(
        "DELETE FROM session_entries WHERE session=?1",
        [session.as_str()],
    )?;
    tx.execute("DELETE FROM sessions WHERE id=?1", [session.as_str()])?;
    let batch = CommitBatch {
        session: session.clone(),
        revision,
        view: None,
        entries: Vec::new(),
        tools: Vec::new(),
        removed: true,
    };
    batch.validate()?;
    if let Some(operation) = operation {
        super::journal::finish_in_transaction(
            &tx,
            operation,
            &Ok(CommandReceipt::Removed {
                session: session.clone(),
            }),
        )
        .map_err(|error| StoreError::Io(error.to_string()))?;
    }
    tx.commit()?;
    Ok(batch)
}

pub(super) fn tools(
    db: &Connection,
    session: &SessionId,
    turn: &crate::domain::TurnId,
    cursor: Option<ToolCursor>,
    requested: Option<usize>,
) -> Result<ToolPage, StoreError> {
    QueryCommand::Tools {
        session: session.clone(),
        turn: turn.clone(),
        cursor: cursor.clone(),
        limit: requested,
    }
    .validate()?;
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
        [session.as_str()],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound);
    }
    let limit = limit(requested, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)?;
    let after = cursor
        .as_ref()
        .map_or("", |cursor| cursor.after_tool.as_str());
    let mut statement = db.prepare("SELECT tool_id,header_json FROM tools WHERE session=?1 AND turn=?2 AND tool_id>?3 ORDER BY tool_id LIMIT ?4")?;
    let mut rows = statement.query(params![
        session.as_str(),
        turn.as_str(),
        after,
        (limit + 1) as i64
    ])?;
    let mut page = ToolPage {
        tools: Vec::new(),
        next_cursor: None,
    };
    let mut more = false;
    while let Some(row) = rows.next()? {
        if page.tools.len() == limit {
            more = true;
            break;
        }
        let id: String = row.get(0)?;
        let header: ToolHeader = serde_json::from_str(&row.get::<_, String>(1)?)?;
        header.validate()?;
        if header.id.as_str() != id || &header.turn != turn {
            return Err(StoreError::Invalid("tool identity mismatch"));
        }
        validate_tool_refs(db, &header)?;
        let previous = page.next_cursor.clone();
        page.next_cursor = Some(ToolCursor {
            version: ProtocolVersion,
            session: session.clone(),
            turn: turn.clone(),
            after_tool: header.id.clone(),
        });
        page.tools.push(header);
        if page.validate().is_err() {
            page.tools.pop();
            page.next_cursor = previous;
            if page.tools.is_empty() {
                return Err(QueryError::TooLarge.into());
            }
            more = true;
            break;
        }
    }
    if !more {
        page.next_cursor = None;
    }
    page.validate()?;
    Ok(page)
}

pub(super) fn list(
    db: &Connection,
    cursor: Option<ListCursor>,
    requested: Option<usize>,
) -> Result<ListPage, StoreError> {
    list_impl(db, cursor, requested, false)
}
pub(super) fn activity_list(
    db: &Connection,
    cursor: Option<ListCursor>,
    requested: Option<usize>,
) -> Result<ListPage, StoreError> {
    list_impl(db, cursor, requested, true)
}
fn list_impl(
    db: &Connection,
    cursor: Option<ListCursor>,
    requested: Option<usize>,
    activity: bool,
) -> Result<ListPage, StoreError> {
    QueryCommand::List {
        cursor: cursor.clone(),
        limit: requested,
    }
    .validate()?;
    let limit = limit(requested, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)?;
    let order_key = if activity {
        "activity_seq"
    } else {
        "created_seq"
    };
    let high: SafeInteger = db.query_row(
        &format!("SELECT COALESCE(MAX({order_key}),0) FROM sessions"),
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
    let mut statement = db.prepare(&format!("SELECT id,harness,cwd,status_json,revision,created_seq,{order_key},(SELECT title FROM session_metadata WHERE session=sessions.id) FROM sessions WHERE {order_key} <= ?1 AND {order_key} < ?2 ORDER BY {order_key} DESC,created_seq DESC LIMIT ?3"))?;
    let mut rows = statement.query(params![max, before as i64, (limit + 1) as i64])?;
    let mut page = ListPage {
        sessions: vec![],
        next_cursor: None,
    };
    let mut more = false;
    let mut last_order_seq = SafeInteger::default();
    while let Some(row) = rows.next()? {
        if page.sessions.len() == limit {
            more = true;
            break;
        }
        let item = SessionSummary {
            title: row.get(7)?,
            id: SessionId::new(row.get::<_, String>(0)?)
                .map_err(|_| StoreError::Invalid("invalid summary id"))?,
            harness: parse_harness(&row.get::<_, String>(1)?)?,
            cwd: crate::domain::WorkspacePath::new(row.get::<_, String>(2)?)
                .map_err(|_| StoreError::Invalid("invalid summary cwd"))?,
            status: serde_json::from_str(&row.get::<_, String>(3)?)?,
            revision: row.get(4)?,
            created_seq: row.get(5)?,
        };
        last_order_seq = row.get(6)?;
        page.sessions.push(item);
        page.next_cursor = Some(ListCursor {
            version: ProtocolVersion,
            max_created_seq: max,
            before_seq: last_order_seq,
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
            before_seq: last_order_seq,
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
