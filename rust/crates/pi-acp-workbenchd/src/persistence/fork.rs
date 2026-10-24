//! Two bounded passes over immutable headers; never reconstruct a session.
use super::{
    content,
    database::{encode, StoreError},
    query,
};
use crate::domain::{
    fork::{ContentHash, ForkCandidate, ForkOrigin, ForkPlan, ForkRequest, ForkRole, ForkScope},
    query::{EntryHeader, SafeInteger, SessionView, TextBody},
    transcript::EntryRole,
    SessionId,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
#[cfg(test)]
#[path = "fork_stream_tests.rs"]
mod tests;

fn unsafe_point() -> StoreError {
    StoreError::Invalid("native fork point is unsafe, stale or ambiguous")
}
const COLUMNS: &str = "se.seq,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,CASE WHEN c.bytes<=16384 THEN c.data ELSE NULL END";
const JOINS: &str = "session_entries se JOIN entries e ON e.entry_id=se.entry_id JOIN contents c ON c.id=e.content_id";
fn feed(db: &Connection, row: &EntryHeader, hash: &mut Sha256) -> Result<(), StoreError> {
    match &row.text {
        TextBody::Inline { text } => hash.update(text.as_bytes()),
        TextBody::Archived { content: reference } => {
            let mut offset = SafeInteger::default();
            let mut whole = Sha256::new();
            loop {
                let slice = content::slice(db, reference, offset, None)?;
                hash.update(slice.text.as_bytes());
                whole.update(slice.text.as_bytes());
                match slice.next_offset {
                    Some(next) => offset = next,
                    None => break,
                }
            }
            if finish(whole) != reference.sha256 {
                return Err(StoreError::Invalid("fork content hash mismatch"));
            }
        }
    }
    Ok(())
}
fn row_hash(row: &EntryHeader) -> ContentHash {
    match &row.text {
        TextBody::Inline { text } => ContentHash::of(text),
        TextBody::Archived { content } => content.sha256.clone(),
    }
}
fn finish(hash: Sha256) -> ContentHash {
    ContentHash::new(format!("{:x}", hash.finalize())).expect("SHA256 encoding")
}
fn role(row: &EntryHeader) -> Option<ForkRole> {
    match row.role {
        EntryRole::User => Some(ForkRole::User),
        EntryRole::Agent => Some(ForkRole::Agent),
        _ => None,
    }
}
pub(super) fn prepare(
    db: &Connection,
    view: &SessionView,
    request: &ForkRequest,
    candidates: &[ForkCandidate],
) -> Result<ForkPlan, StoreError> {
    let current = query::view(db, &view.id)?;
    if encode(&current)? != encode(view)? {
        return Err(StoreError::Conflict);
    }
    if view.active_turn.is_some() || view.configuration_intent.is_some() {
        return Err(StoreError::Invalid("source session is busy"));
    }
    let native = view.provider_session.clone().ok_or_else(unsafe_point)?;
    let mut selected = db.prepare(&format!(
        "SELECT {COLUMNS} FROM {JOINS} WHERE se.session=?1 AND se.entry_id=?2"
    ))?;
    let mut rows = selected.query(params![view.id.as_str(), request.entry.as_str()])?;
    let selected = content::header(rows.next()?.ok_or_else(unsafe_point)?)?;
    let target_role = role(&selected).ok_or_else(unsafe_point)?;
    if selected.image.is_some() {
        return Err(unsafe_point());
    }
    let mut start = selected.seq;
    let mut end = selected.seq;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut agents_in_turn = 0;
    let mut image = false;
    let mut last_role = None;
    // Pass 1 proves the exact requested group, including reuse elsewhere in
    // the same turn. Hash only that group's Agent content in bounded slices.
    let mut statement = db.prepare(&format!(
        "SELECT {COLUMNS} FROM {JOINS} WHERE se.session=?1 ORDER BY se.seq"
    ))?;
    let mut rows = statement.query([view.id.as_str()])?;
    while let Some(row) = rows.next()? {
        let row = content::header(row)?;
        if row.turn == selected.turn && row.role == EntryRole::Agent {
            agents_in_turn += 1;
        }
        let included = if target_role == ForkRole::User || selected.message.is_none() {
            row.seq == selected.seq
        } else {
            row.turn == selected.turn
                && row.message == selected.message
                && matches!(row.role, EntryRole::Agent | EntryRole::Thought)
        };
        if included {
            if count == 0 {
                start = row.seq;
            }
            end = row.seq;
            count += 1;
            image |= row.image.is_some();
            last_role = Some(row.role.clone());
            if role(&row).as_ref() == Some(&target_role) {
                feed(db, &row, &mut hash)?;
            }
        }
    }
    if count == 0
        || image
        || end != selected.seq
        || end.get() - start.get() + 1 != count
        || (target_role == ForkRole::Agent
            && (last_role != Some(EntryRole::Agent)
                || (selected.message.is_none() && agents_in_turn != 1)))
    {
        return Err(unsafe_point());
    }
    let selected_hash = finish(hash);
    // Pass 2 annotates each stream with complete key cardinality. That excludes
    // non-contiguous/reused keys without retaining a Rust map of all groups.
    let sql = format!("WITH groups AS MATERIALIZED (SELECT e.turn,e.message,min(se.seq) AS first,max(se.seq) AS last,count(*) AS n FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?1 AND e.role IN ('Agent','Thought') AND e.message IS NOT NULL GROUP BY e.turn,e.message) SELECT {COLUMNS},g.first,g.last,g.n FROM {JOINS} LEFT JOIN groups g ON g.turn=e.turn AND g.message=e.message WHERE se.session=?1 ORDER BY se.seq");
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query([view.id.as_str()])?;
    let mut group_start = None;
    let mut group_hash = Sha256::new();
    while let Some(sql_row) = rows.next()? {
        let first: Option<SafeInteger> = sql_row.get(12)?;
        let last: Option<SafeInteger> = sql_row.get(13)?;
        let count: Option<i64> = sql_row.get(14)?;
        let row = content::header(sql_row)?;
        // The baseline also rejects an equal standalone row even when its
        // surrounding stream is incomplete, thought-only or otherwise unsafe.
        if (row.seq < start || row.seq > end)
            && role(&row).as_ref() == Some(&target_role)
            && row_hash(&row) == selected_hash
        {
            return Err(unsafe_point());
        }
        if target_role != ForkRole::Agent
            || !matches!(row.role, EntryRole::Agent | EntryRole::Thought)
        {
            continue;
        }
        let (Some(first), Some(last), Some(count)) = (first, last, count) else {
            continue;
        };
        if last.get() - first.get() + 1 != count as u64 {
            continue;
        }
        if group_start != Some(first) {
            group_start = Some(first);
            group_hash = Sha256::new();
        }
        if row.role == EntryRole::Agent {
            feed(db, &row, &mut group_hash)?;
        }
        if row.seq == last
            && row.role == EntryRole::Agent
            && first != start
            && finish(group_hash.clone()) == selected_hash
        {
            return Err(unsafe_point());
        }
    }
    let mut matching = candidates
        .iter()
        .filter(|candidate| candidate.role == target_role && candidate.text == selected_hash);
    let chosen = matching.next().ok_or_else(unsafe_point)?;
    if !chosen.safe || matching.next().is_some() {
        return Err(unsafe_point());
    }
    let target = chosen.target.clone();
    Ok(ForkPlan {
        scope: ForkScope {
            session: view.id.clone(),
            native,
            harness: view.harness.clone(),
            cwd: view.cwd.clone(),
        },
        revision: view.revision,
        entry_seq: selected.seq,
        target: target.clone(),
        new_session_id: SessionId::generate(),
        origin: ForkOrigin {
            session: view.id.clone(),
            entry: request.entry.clone(),
            target,
        },
    })
}

pub(super) fn adopt(
    db: &mut Connection,
    plan: ForkPlan,
    native: crate::domain::ProviderSessionId,
) -> Result<(SessionView, crate::domain::query::SessionSummary), StoreError> {
    let tx = db.transaction()?;
    let source = query::view(&tx, &plan.scope.session)?;
    if source.revision != plan.revision
        || source.provider_session.as_ref() != Some(&plan.scope.native)
        || source.cwd != plan.scope.cwd
        || source.harness != plan.scope.harness
        || source.active_turn.is_some()
        || source.configuration_intent.is_some()
        || native == plan.scope.native
        || plan.new_session_id == source.id
        || plan.origin.session != source.id
        || plan.origin.target != plan.target
    {
        return Err(StoreError::Conflict);
    }
    let (cut_entry, cut_turn): (String, String) = tx.query_row("SELECT e.entry_id,e.turn FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?1 AND se.seq=?2", params![source.id.as_str(), plan.entry_seq], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if cut_entry != plan.origin.entry.as_str() {
        return Err(StoreError::Conflict);
    }
    let mut branch = source.clone();
    branch.id = plan.new_session_id;
    branch.provider_session = Some(native);
    branch.revision = SafeInteger::default();
    branch.last_entry_seq = SafeInteger::default();
    branch.origin = Some(plan.origin);
    branch.status = crate::domain::SessionStatus::Idle;
    branch.config = crate::domain::session::SessionConfig {
        options: Default::default(),
        model: None,
        mode: None,
    };
    branch.configuration_intent = None;
    branch.catalogue = Default::default();
    branch.plan = Default::default();
    branch.usage = Default::default();
    branch.pending_interactions.clear();
    branch.active_turn = None;
    let created = query::insert_view(&tx, &branch)?;
    tx.execute("INSERT INTO session_entries(session,seq,entry_id) SELECT ?1,seq,entry_id FROM session_entries WHERE session=?2 AND seq<=?3", params![branch.id.as_str(), source.id.as_str(), plan.entry_seq])?;
    // A turn first appearing before the cut but ending after it is not provably
    // earlier. Copy only tools whose entire linked turn is strictly earlier.
    let cut_start: SafeInteger = tx.query_row("SELECT min(se.seq) FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?1 AND e.turn=?2", params![source.id.as_str(), cut_turn], |row| row.get(0))?;
    tx.execute("INSERT INTO tools(session,turn,tool_id,header_json) SELECT ?1,t.turn,t.tool_id,t.header_json FROM tools t WHERE t.session=?2 AND t.turn<>?4 AND EXISTS (SELECT 1 FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?2 AND e.turn=t.turn AND se.seq<?3) AND NOT EXISTS (SELECT 1 FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id WHERE se.session=?2 AND e.turn=t.turn AND se.seq>=?3)", params![branch.id.as_str(), source.id.as_str(), cut_start, cut_turn])?;
    branch.last_entry_seq = plan.entry_seq;
    branch.validate()?;
    tx.execute(
        "UPDATE sessions SET last_entry_seq=?2,hot_state_json=?3 WHERE id=?1",
        params![branch.id.as_str(), branch.last_entry_seq, encode(&branch)?],
    )?;
    crate::diagnostics::sqlite_commit(tx)?;
    let summary = query::summary(&branch, created);
    Ok((branch, summary))
}
