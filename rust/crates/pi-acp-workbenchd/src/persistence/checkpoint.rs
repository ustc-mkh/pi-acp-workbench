//! Bound WAL reuse work without waiting indefinitely for a pinned reader.
//! Only the existing writer invokes this between accepted requests.
use super::database::StoreError;
use rusqlite::Connection;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

const WAL_REUSE_BYTES: u64 = 16 * 1024 * 1024;
const PROBE_INTERVAL: Duration = Duration::from_secs(1);
const RESTART_WAIT: Duration = Duration::from_millis(20);
const NORMAL_BUSY_WAIT: Duration = Duration::from_millis(5000);

pub(super) struct Checkpoint {
    wal: PathBuf,
    last_probe: Instant,
}

#[derive(Debug)]
pub(super) struct Outcome {
    pub busy: bool,
    pub log_frames: i64,
    pub checkpointed_frames: i64,
    pub elapsed: Duration,
}

impl Checkpoint {
    pub fn new(root: &std::path::Path) -> Self {
        Self {
            wal: root.join("workbench.sqlite3-wal"),
            last_probe: Instant::now(),
        }
    }

    pub fn poll(&mut self, db: &Connection, now: Instant) -> Result<Option<Outcome>, StoreError> {
        if now.saturating_duration_since(self.last_probe) < PROBE_INTERVAL {
            return Ok(None);
        }
        self.last_probe = now;
        let bytes = match std::fs::metadata(&self.wal) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if bytes < WAL_REUSE_BYTES {
            return Ok(None);
        }
        let page_size: u32 = db.pragma_query_value(None, "page_size", |row| row.get(0))?;
        let began = Instant::now();
        // PASSIVE alone backfills pages but can indefinitely fail to reuse the
        // file under overlapping short readers. RESTART lets existing readers
        // finish, with a small busy-wait budget; a pinned reader remains safe.
        db.busy_timeout(RESTART_WAIT)?;
        let result = (|| -> Result<Option<Outcome>, rusqlite::Error> {
            let (_, frames, _): (i64, i64, i64) =
                db.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            // A reused WAL can retain its physical high-water allocation.
            // Probe logical frames to avoid restarting that small log each second.
            if frames <= 0
                || (frames as u64)
                    .saturating_mul(u64::from(page_size) + 24)
                    .saturating_add(32)
                    < WAL_REUSE_BYTES
            {
                return Ok(None);
            }
            let (busy, log_frames, checkpointed_frames): (i64, i64, i64) =
                db.query_row("PRAGMA wal_checkpoint(RESTART)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            Ok(Some(Outcome {
                busy: busy != 0,
                log_frames,
                checkpointed_frames,
                elapsed: began.elapsed(),
            }))
        })();
        // Restore the normal transaction policy even when checkpointing fails.
        db.busy_timeout(NORMAL_BUSY_WAIT)?;
        Ok(result?)
    }
}

#[cfg(test)]
#[path = "checkpoint_tests.rs"]
mod tests;
