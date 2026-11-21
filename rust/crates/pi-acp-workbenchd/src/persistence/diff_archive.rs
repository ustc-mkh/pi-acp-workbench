//! Bounded decoded views of immutable turn archives, owned by each SQLite executor.
//! No negative caching: a missing archive may be committed by the writer later.
use super::database::StoreError;
use crate::{
    domain::{SessionId, TurnId},
    workspace_review::{DiffStatus, FileStatus, TurnDiff},
};
use rusqlite::OptionalExtension;
use std::{collections::VecDeque, sync::Arc};

const CACHE_BYTES: usize = 48 * 1024 * 1024;
const CACHE_ITEMS: usize = 4;
struct CachedDiff {
    session: SessionId,
    turn: TurnId,
    diff: Arc<TurnDiff>,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct DiffArchive {
    entries: VecDeque<CachedDiff>,
    bytes: usize,
}
impl DiffArchive {
    pub fn read(
        &mut self,
        connection: &rusqlite::Connection,
        session: &SessionId,
        turn: &TurnId,
    ) -> Result<Option<Arc<TurnDiff>>, StoreError> {
        if let Some(index) = self
            .entries
            .iter()
            .position(|e| &e.session == session && &e.turn == turn)
        {
            // Session removal cascades to turn_diffs on the writer connection.
            // Recheck identity cheaply so a cache never resurrects deleted history.
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM turn_diffs WHERE session=?1 AND turn=?2)",
                rusqlite::params![session.as_str(), turn.as_str()],
                |row| row.get(0),
            )?;
            let entry = self.entries.remove(index).unwrap();
            if !exists {
                self.bytes -= entry.bytes;
                return Ok(None);
            }
            let diff = entry.diff.clone();
            self.entries.push_back(entry);
            return Ok(Some(diff));
        }
        let json: Option<String> = connection
            .query_row(
                "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                rusqlite::params![session.as_str(), turn.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = json else { return Ok(None) };
        let mut diff: TurnDiff = serde_json::from_str(&json)
            .map_err(|_| StoreError::Invalid("turn diff archive is corrupt"))?;
        if diff.status == DiffStatus::Complete
            && diff
                .files
                .iter()
                .any(|file| file.status == FileStatus::Added && !file.added_path_verified)
        {
            diff.status = DiffStatus::Partial;
            diff.warnings
                .push("Older snapshot cannot verify added paths; undo is disabled.".into());
        }
        let bytes = retained_bytes(&diff);
        let diff = Arc::new(diff);
        if bytes <= CACHE_BYTES {
            while self.entries.len() >= CACHE_ITEMS || self.bytes + bytes > CACHE_BYTES {
                self.bytes -= self.entries.pop_front().unwrap().bytes;
            }
            self.bytes += bytes;
            self.entries.push_back(CachedDiff {
                session: session.clone(),
                turn: turn.clone(),
                diff: diff.clone(),
                bytes,
            });
        }
        Ok(Some(diff))
    }
}
fn retained_bytes(diff: &TurnDiff) -> usize {
    std::mem::size_of::<TurnDiff>()
        + diff.files.capacity() * std::mem::size_of::<crate::workspace_review::FileDiff>()
        + diff.warnings.capacity() * std::mem::size_of::<String>()
        + diff.warnings.iter().map(String::capacity).sum::<usize>()
        + diff
            .files
            .iter()
            .map(|file| {
                file.path.capacity()
                    + [
                        &file.before_hash,
                        &file.after_hash,
                        &file.before,
                        &file.after,
                        &file.patch,
                        &file.omitted,
                    ]
                    .into_iter()
                    .filter_map(|s| s.as_ref())
                    .map(String::capacity)
                    .sum::<usize>()
            })
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (rusqlite::Connection, SessionId, TurnId) {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE turn_diffs(session TEXT, turn TEXT, diff_json TEXT, PRIMARY KEY(session,turn));").unwrap();
        (connection, SessionId::generate(), TurnId::generate())
    }
    fn insert(connection: &rusqlite::Connection, session: &SessionId, turn: &TurnId) {
        connection.execute("INSERT INTO turn_diffs VALUES (?1,?2,?3)",rusqlite::params![session.as_str(),turn.as_str(),r#"{"status":"complete","files":[],"warnings":[],"added":0,"removed":0,"next_offset":null}"#]).unwrap();
    }
    #[test]
    fn missing_archives_can_arrive_and_repeated_reads_reuse_the_decoded_value() {
        let (connection, session, turn) = fixture();
        let mut cache = DiffArchive::default();
        assert!(cache.read(&connection, &session, &turn).unwrap().is_none());
        insert(&connection, &session, &turn);
        let first = cache.read(&connection, &session, &turn).unwrap().unwrap();
        let second = cache.read(&connection, &session, &turn).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        connection.execute("DELETE FROM turn_diffs", []).unwrap();
        assert!(cache.read(&connection, &session, &turn).unwrap().is_none());
        assert_eq!(cache.bytes, 0);
    }
    #[test]
    fn legacy_added_paths_remain_readable_and_disable_undo() {
        let (connection, session, turn) = fixture();
        let legacy = r#"{"status":"complete","files":[{"path":"report.txt","status":"added","added":1,"removed":0,"before":"","after":"notes"}],"warnings":[],"added":1,"removed":0}"#;
        connection
            .execute(
                "INSERT INTO turn_diffs VALUES (?1,?2,?3)",
                rusqlite::params![session.as_str(), turn.as_str(), legacy],
            )
            .unwrap();
        let diff = DiffArchive::default()
            .read(&connection, &session, &turn)
            .unwrap()
            .unwrap();
        assert_eq!(diff.status, DiffStatus::Partial);
        assert_eq!(diff.files[0].after.as_deref(), Some("notes"));
    }
    #[test]
    fn least_recent_archives_are_evicted() {
        let (connection, session, first) = fixture();
        let mut cache = DiffArchive::default();
        insert(&connection, &session, &first);
        let original = cache.read(&connection, &session, &first).unwrap().unwrap();
        for _ in 0..CACHE_ITEMS {
            let turn = TurnId::generate();
            insert(&connection, &session, &turn);
            cache.read(&connection, &session, &turn).unwrap();
        }
        assert_eq!(cache.entries.len(), CACHE_ITEMS);
        assert!(cache.bytes <= CACHE_BYTES);
        assert!(!Arc::ptr_eq(
            &original,
            &cache.read(&connection, &session, &first).unwrap().unwrap()
        ));
    }
}
