//! Frozen targets, bounded per-session removal, and durable partial results.
//! Native files, usage, receipts and delivery manifests are never deleted here.
use super::{database::StoreError, query};
use crate::domain::{
    operation::OperationTicket,
    query::{CommandReceipt, HistoryClearReport, SessionFilter},
    OperationId, SessionId,
};
use rusqlite::{params, Connection};
pub(crate) enum Request {
    Prepare {
        filter: SessionFilter,
        ticket: OperationTicket,
    },
    Next {
        job: OperationId,
    },
    Result {
        job: OperationId,
        session: SessionId,
        error: Option<String>,
    },
    Settle {
        job: OperationId,
        ticket: OperationTicket,
    },
}
pub(crate) enum Output {
    Receipt(CommandReceipt),
    Targets(Vec<SessionId>),
    Saved,
}
fn report(db: &Connection, job: &OperationId, preview: bool) -> Result<CommandReceipt, StoreError> {
    let (active, pending_deliveries): (i64, i64) = db.query_row(
        "SELECT active,pending_deliveries FROM history_clear_jobs WHERE job=?1",
        [job.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (total, remaining, failed): (i64, i64, i64) = db.query_row("SELECT count(*),COALESCE(sum(state='pending'),0),COALESCE(sum(state='failed'),0) FROM history_clear_targets WHERE job=?1", [job.as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    Ok(CommandReceipt::HistoryClear {
        report: HistoryClearReport {
            job: job.clone(),
            total: total as usize,
            remaining: remaining as usize,
            failed: failed as usize,
            active: active as usize,
            pending_deliveries: pending_deliveries as usize,
            preview,
        },
    })
}
pub(crate) fn execute(db: &mut Connection, request: Request) -> Result<Output, StoreError> {
    match request {
        Request::Prepare { filter, ticket } => {
            if !filter.valid() {
                return Err(StoreError::Invalid("invalid history filter"));
            }
            let tx = db.transaction()?;
            let h = filter.harness.as_ref().map(query::harness_name);
            tx.execute("INSERT INTO history_clear_jobs(job,filter_json,active,pending_deliveries) VALUES(?1,?2,0,0)", params![ticket.operation.as_str(),super::database::encode(&filter)?])?;
            tx.execute("INSERT INTO history_clear_targets(job,session) SELECT ?1,s.id FROM sessions s LEFT JOIN session_metadata m ON m.session=s.id WHERE (?2 IS NULL OR s.harness=?2) AND (?3='' OR instr(lower(COALESCE(m.title,'')),lower(?3))>0 OR instr(lower(s.cwd),lower(?3))>0 OR instr(lower(s.id),lower(?3))>0)",params![ticket.operation.as_str(),h,filter.text])?;
            tx.execute("UPDATE history_clear_jobs SET active=(SELECT count(*) FROM sessions s JOIN history_clear_targets t ON t.session=s.id WHERE t.job=?1 AND s.status_json IN ('\"Running\"','\"Waiting\"','\"Cancelling\"')),pending_deliveries=(SELECT count(*) FROM deliveries d WHERE d.status='Pending' AND COALESCE(json_extract(d.target_json,'$.Session.session'),json_extract(d.payload_json,'$.Input.session'),json_extract(d.payload_json,'$.Turn.session'),json_extract(d.payload_json,'$.HistoryEntry.session')) IN (SELECT session FROM history_clear_targets WHERE job=?1)) WHERE job=?1",[ticket.operation.as_str()])?;
            let receipt = report(&tx, &ticket.operation, true)?;
            super::journal::finish_in_transaction(&tx, &ticket, &Ok(receipt.clone()))
                .map_err(|e| StoreError::Io(e.to_string()))?;
            crate::diagnostics::sqlite_commit(tx)?;
            Ok(Output::Receipt(receipt))
        }
        Request::Next { job } => {
            // Check job existence rather than treating an unknown identity as done.
            report(db, &job, false)?;
            let mut statement = db.prepare("SELECT session FROM history_clear_targets WHERE job=?1 AND state='pending' ORDER BY session LIMIT 10")?;
            let ids = statement
                .query_map([job.as_str()], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Output::Targets(
                ids.into_iter()
                    .map(|id| {
                        SessionId::new(id).map_err(|_| StoreError::Invalid("invalid clear target"))
                    })
                    .collect::<Result<_, _>>()?,
            ))
        }
        Request::Result {
            job,
            session,
            error,
        } => {
            db.execute("UPDATE history_clear_targets SET state=?3,error=?4 WHERE job=?1 AND session=?2 AND state='pending'",params![job.as_str(),session.as_str(),if error.is_some(){"failed"}else{"removed"},error.map(|e|e.chars().take(512).collect::<String>())])?;
            Ok(Output::Saved)
        }
        Request::Settle { job, ticket } => {
            let tx = db.transaction()?;
            let receipt = report(&tx, &job, false)?;
            super::journal::finish_in_transaction(&tx, &ticket, &Ok(receipt.clone()))
                .map_err(|e| StoreError::Io(e.to_string()))?;
            crate::diagnostics::sqlite_commit(tx)?;
            Ok(Output::Receipt(receipt))
        }
    }
}
