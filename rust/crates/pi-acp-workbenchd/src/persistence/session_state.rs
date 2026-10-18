//! Full-state load/save for the existing actor/fork contracts until T05/T06.
//! Only hot view and normalized immutable archives live in SQL; no file reader.
use super::{
    commit::validate_prefix,
    content,
    database::{encode, SessionCommit, StoreError},
    payload, query,
};
use crate::domain::{
    ids::*,
    query::{SafeInteger, SessionView, ToolBody, ToolHeader},
    tool::{ToolCall, ToolContent, ToolDetails},
    transcript::Transcript,
    transition::{NewEntry, ToolUpdate},
    SessionState,
};
use rusqlite::{params, Connection};
use tokio::sync::oneshot;
type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum Request {
    Load {
        id: SessionId,
        reply: Reply<Option<SessionState>>,
    },
    List {
        reply: Reply<Vec<SessionState>>,
    },
    Save {
        state: Box<SessionState>,
        reply: Reply<()>,
    },
    Remove {
        id: SessionId,
        reply: Reply<()>,
    },
}
pub(super) fn run(db: &mut Connection, request: Request) {
    match request {
        Request::Load { id, reply } => {
            let _ = reply.send(load(db, &id));
        }
        Request::List { reply } => {
            let _ = reply.send(list(db));
        }
        Request::Save { state, reply } => {
            let _ = reply.send(save(db, *state));
        }
        Request::Remove { id, reply } => {
            let _ = reply.send(remove(db, &id));
        }
    }
}
pub(super) fn load(db: &Connection, id: &SessionId) -> Result<Option<SessionState>, StoreError> {
    let view = match query::view(db, id) {
        Ok(view) => view,
        Err(StoreError::NotFound) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut transcript = Transcript {
        origin: view.origin.clone(),
        ..Default::default()
    };
    let mut statement =
        db.prepare("SELECT seq,entry_id FROM session_entries WHERE session=?1 ORDER BY seq")?;
    let mut rows = statement.query([id.as_str()])?;
    while let Some(row) = rows.next()? {
        let seq: SafeInteger = row.get(0)?;
        if seq.get() != transcript.entries.len() as u64 + 1 {
            return Err(StoreError::Invalid("session entry sequence mismatch"));
        }
        let entry = EntryId::new(row.get::<_, String>(1)?)
            .map_err(|_| StoreError::Invalid("invalid linked entry id"))?;
        transcript.entries.push(payload::entry(db, &entry)?);
    }
    if transcript.entries.len() as u64 != view.last_entry_seq.get() {
        return Err(StoreError::Invalid("session history high water mismatch"));
    }
    let mut statement = db.prepare(
        "SELECT turn,tool_id,header_json FROM tools WHERE session=?1 ORDER BY turn,tool_id",
    )?;
    let mut rows = statement.query([id.as_str()])?;
    while let Some(row) = rows.next()? {
        let header: ToolHeader = serde_json::from_str(&row.get::<_, String>(2)?)?;
        header.validate()?;
        if header.turn.as_str() != row.get::<_, String>(0)?
            || header.id.as_str() != row.get::<_, String>(1)?
        {
            return Err(StoreError::Invalid("tool identity mismatch"));
        }
        let call = tool(db, header)?;
        transcript
            .tools
            .entry(call.turn.clone())
            .or_default()
            .insert(call.id.clone(), call);
    }
    Ok(Some(SessionState {
        id: view.id,
        provider_session: view.provider_session,
        harness: view.harness,
        cwd: view.cwd,
        status: view.status,
        transcript,
        plan: view.plan,
        active_turn: view.active_turn,
        pending_interactions: view.pending_interactions,
        usage: view.usage,
        config: view.config,
        configuration_intent: view.configuration_intent,
        catalogue: view.catalogue,
        revision: view.revision.get(),
    }))
}
fn tool(db: &Connection, header: ToolHeader) -> Result<ToolCall, StoreError> {
    let read = |reference: &crate::domain::query::ContentRef| content::read_text(db, reference);
    let mut bodies = Vec::new();
    for body in header.content {
        bodies.push(match body {
            ToolBody::Text { content } => ToolContent::Text {
                text: read(&content)?,
            },
            ToolBody::Diff {
                path,
                old_text,
                new_text,
            } => ToolContent::Diff {
                path,
                old_text: old_text.as_ref().map(read).transpose()?,
                new_text: read(&new_text)?,
            },
            ToolBody::ResourceText {
                uri,
                content,
                mime_type,
            } => ToolContent::ResourceText {
                uri,
                text: read(&content)?,
                mime_type,
            },
            ToolBody::ResourceLink {
                uri,
                name,
                mime_type,
            } => ToolContent::ResourceLink {
                uri,
                name,
                mime_type,
            },
            ToolBody::TerminalReference { id } => ToolContent::TerminalReference { id },
            ToolBody::Unsupported { kind } => ToolContent::Unsupported { kind },
        });
    }
    Ok(ToolCall {
        id: header.id,
        turn: header.turn,
        title: header.title,
        status: header.status,
        details: ToolDetails {
            kind: header.kind,
            name: header.name,
            locations: header.locations,
            content: bodies,
        },
    })
}
pub(super) fn list(db: &Connection) -> Result<Vec<SessionState>, StoreError> {
    let mut statement = db.prepare("SELECT id FROM sessions ORDER BY id")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            let id = SessionId::new(id).map_err(|_| StoreError::Invalid("invalid session id"))?;
            load(db, &id)?.ok_or(StoreError::NotFound)
        })
        .collect()
}
fn save(db: &mut Connection, state: SessionState) -> Result<(), StoreError> {
    let tx = db.transaction()?;
    let previous = load(&tx, &state.id)?;
    if let Some(old) = &previous {
        if state.revision == old.revision {
            if encode(old)? != encode(&state)? {
                return Err(StoreError::Conflict);
            }
            tx.commit()?;
            return Ok(());
        }
        validate_prefix(old, &state)?;
    }
    let previous_seq = previous
        .as_ref()
        .map_or(0, |state| state.transcript.entries.len());
    let view = SessionView::from_state(
        &state,
        SafeInteger::new(state.transcript.entries.len() as u64)?,
    )?;
    let mut append = Vec::new();
    for entry in state.transcript.entries.iter().skip(previous_seq) {
        let image = entry
            .image
            .as_ref()
            .map(|reference| {
                let asset = content::image(&tx, reference.id())?;
                if asset.image() != reference {
                    return Err(StoreError::Invalid("entry image reference mismatch"));
                }
                Ok(asset)
            })
            .transpose()?;
        append.push(NewEntry {
            id: entry.id.clone(),
            turn: entry.turn.clone(),
            role: entry.role.clone(),
            message: entry.message.clone(),
            text: payload::entry_content(entry)?,
            image,
        });
    }
    let mut tool_updates = Vec::new();
    for (turn, tools) in &state.transcript.tools {
        for (id, call) in tools {
            if turn != &call.turn || id != &call.id {
                return Err(StoreError::Invalid("tool identity mismatch"));
            }
            let old = previous
                .as_ref()
                .and_then(|state| state.transcript.tools.get(turn))
                .and_then(|tools| tools.get(id));
            if old.map(encode).transpose()? != Some(encode(call)?) {
                tool_updates.push(ToolUpdate::from_call(call)?);
            }
        }
    }
    let change = SessionCommit {
        expected_revision: SafeInteger::new(previous.as_ref().map_or(0, |state| state.revision))?,
        next: view,
        append,
        tool_updates,
        contents: vec![],
        deliveries: vec![],
        view_changed: true,
    };
    if previous.is_none() {
        query::insert_view(&tx, &change.next)?;
    } else {
        let changed = tx.execute("UPDATE sessions SET revision=?2,last_entry_seq=?3,status_json=?4,hot_state_json=?5 WHERE id=?1 AND revision=?6", params![state.id.as_str(), change.next.revision, change.next.last_entry_seq, encode(&change.next.status)?, encode(&change.next)?, change.expected_revision])?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
    }
    query::apply_records(&tx, &change, SafeInteger::new(previous_seq as u64)?)?;
    tx.commit()?;
    Ok(())
}
pub(super) fn remove(db: &mut Connection, id: &SessionId) -> Result<(), StoreError> {
    let tx = db.transaction()?;
    // Archives, operation receipts and intents outlive the session's links.
    if load(&tx, id)?.is_some() {
        tx.execute("DELETE FROM tools WHERE session=?1", [id.as_str()])?;
        tx.execute(
            "DELETE FROM session_entries WHERE session=?1",
            [id.as_str()],
        )?;
        tx.execute("DELETE FROM sessions WHERE id=?1", [id.as_str()])?;
    }
    tx.commit()?;
    Ok(())
}
