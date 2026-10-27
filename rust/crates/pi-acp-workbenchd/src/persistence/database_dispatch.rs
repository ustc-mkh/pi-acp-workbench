//! SQLite request execution. Runs only on the fixed writer/reader threads.
use super::{database::StoreError, database_request::StoreRequest, query};
use rusqlite::OptionalExtension;

pub(super) fn execute_request(connection: &mut rusqlite::Connection, request: StoreRequest) {
    match request {
        StoreRequest::ContextStage {
            session,
            action,
            reply,
        } => {
            let _ = reply.send(super::model_context::stage(connection, &session, &action));
        }
        StoreRequest::ContextSnapshot { reply } => {
            let _ = reply.send(super::model_context::snapshot(connection));
        }
        StoreRequest::ContextSettle {
            revision,
            error,
            reply,
        } => {
            let _ = reply.send(super::model_context::settle(
                connection,
                revision,
                error.as_deref(),
            ));
        }
        StoreRequest::ManagementRead { query, reply } => {
            let _ = reply.send(super::management::read(connection, &query));
        }
        StoreRequest::ManagementUpdate {
            session,
            action,
            ticket,
            reply,
        } => {
            let _ = reply.send(super::management::update(
                connection,
                &session,
                &action,
                ticket.as_ref(),
            ));
        }
        StoreRequest::ModelDefaults {
            session,
            models,
            reply,
        } => {
            let _ = reply.send(super::management::models(
                connection,
                session.as_ref(),
                &models,
            ));
        }
        StoreRequest::TitleJob { session, reply } => {
            let _ = reply.send(super::management::title_job(connection, &session));
        }
        StoreRequest::TitleResult {
            session,
            result,
            reply,
        } => {
            let _ = reply.send(super::management::title_result(
                connection, &session, &result,
            ));
        }
        StoreRequest::TurnDiffSave {
            session,
            turn,
            diff,
            reply,
        } => {
            let result = (|| {
                let encoded = serde_json::to_string(&diff)
                    .map_err(|_| StoreError::Invalid("turn diff encode failed"))?;
                if encoded.len() > 32 * 1024 * 1024 {
                    return Err(StoreError::Invalid("turn diff exceeds archive budget"));
                }
                connection.execute("INSERT INTO turn_diffs(session,turn,diff_json) VALUES (?1,?2,?3) ON CONFLICT(session,turn) DO NOTHING", rusqlite::params![session.as_str(),turn.as_str(),encoded])?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffPage {
            session,
            turn,
            offset,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|v| {
                    v.map(|j| {
                        serde_json::from_str::<crate::workspace_review::TurnDiff>(&j)
                            .map_err(|_| StoreError::Invalid("turn diff corrupt"))
                    })
                    .transpose()
                })
                .and_then(|d| {
                    crate::workspace_review::summary(d, offset).map_err(StoreError::Query)
                });
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffContent {
            session,
            turn,
            file,
            after,
            offset,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|v| v.ok_or(StoreError::NotFound))
                .and_then(|j| {
                    serde_json::from_str::<crate::workspace_review::TurnDiff>(&j)
                        .map_err(|_| StoreError::Invalid("turn diff corrupt"))
                })
                .and_then(|d| {
                    crate::workspace_review::content(&d, file, after, offset.get() as usize)
                        .map_err(StoreError::Query)
                });
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffGet {
            session,
            turn,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|value| {
                    value
                        .map(|json| {
                            serde_json::from_str(&json)
                                .map_err(|_| StoreError::Invalid("turn diff archive is corrupt"))
                        })
                        .transpose()
                });
            let _ = reply.send(result);
        }
        StoreRequest::Attached { session, reply } => {
            let result = (|| {
                let tx = connection.transaction()?;
                let mut attached = crate::domain::query::Attached {
                    view: query::view(&tx, &session)?,
                    recent_page: query::history(&tx, &session, None, None)?,
                };
                while attached.validate().is_err() {
                    if attached.recent_page.entries.len() <= 1 {
                        return Err(crate::domain::query::QueryError::TooLarge.into());
                    }
                    attached.recent_page.entries.remove(0);
                    attached.recent_page.next_cursor = Some(crate::domain::query::HistoryCursor {
                        version: crate::domain::query::ProtocolVersion,
                        session: session.clone(),
                        max_entry_seq: attached.view.last_entry_seq,
                        before_seq: attached.recent_page.entries[0].seq,
                    });
                }
                crate::diagnostics::sqlite_commit(tx)?;
                Ok(attached)
            })();
            let _ = reply.send(result);
        }
        StoreRequest::Tools {
            session,
            turn,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::tools(connection, &session, &turn, cursor, limit));
        }
        StoreRequest::Remove {
            session,
            operation,
            reply,
        } => {
            let _ = reply.send(query::remove(connection, &session, operation.as_ref()));
        }
        StoreRequest::Tool {
            session,
            turn,
            tool,
            reply,
        } => {
            let _ = reply.send(query::tool(connection, &session, &turn, &tool));
        }
        StoreRequest::PrepareFork {
            view,
            request,
            candidates,
            reply,
        } => {
            let result = (|| {
                let tx = connection.transaction()?;
                let plan = super::fork::prepare(&tx, &view, &request, &candidates)?;
                crate::diagnostics::sqlite_commit(tx)?;
                Ok(plan)
            })();
            let _ = reply.send(result);
        }
        StoreRequest::AdoptFork {
            plan,
            native,
            reply,
        } => {
            let _ = reply.send(super::fork::adopt(connection, *plan, native));
        }
        #[cfg(test)]
        StoreRequest::Create { view, reply } => {
            let _ = reply.send(query::create(connection, &view));
        }
        StoreRequest::Commit { commit, reply } => {
            let _ = reply.send(query::commit(connection, *commit));
        }
        StoreRequest::Summary { session, reply } => {
            let _ = reply.send(query::summary_by_id(connection, &session));
        }
        StoreRequest::WorkerActivity { session, reply } => {
            let _ = reply.send(query::worker_activity(connection, &session));
        }
        StoreRequest::View { session, reply } => {
            let _ = reply.send(query::view(connection, &session));
        }
        StoreRequest::List {
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::list(connection, cursor, limit));
        }
        StoreRequest::HistoryClear { request, reply } => {
            let _ = reply.send(super::history_clear::execute(connection, request));
        }
        StoreRequest::Search {
            filter,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::search(connection, filter, cursor, limit));
        }
        StoreRequest::ActivityList {
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::activity_list(connection, cursor, limit));
        }
        StoreRequest::History {
            session,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::history(connection, &session, cursor, limit));
        }
        StoreRequest::ContentSlice {
            content,
            offset,
            length,
            reply,
        } => {
            let _ = reply.send(super::content::slice(connection, &content, offset, length));
        }
        StoreRequest::Content { content, reply } => {
            let _ = reply.send(super::content::read_text(connection, &content));
        }
        #[cfg(test)]
        StoreRequest::ArchiveImage { asset, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = connection.transaction()?;
                super::content::put_image(&tx, &asset)?;
                crate::diagnostics::sqlite_commit(tx)?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        StoreRequest::Image { id, reply } => {
            let _ = reply.send(super::content::image(connection, &id));
        }
        StoreRequest::Delivery(request) => {
            super::delivery::execute(connection, *request);
        }
        StoreRequest::Payload(request) => {
            super::payload::execute(connection, *request);
        }
        StoreRequest::TelegramInbox(request) => {
            super::telegram_sql::execute(connection, *request);
        }
        StoreRequest::TelegramEffect(request) => {
            super::telegram_effect::execute(connection, *request);
        }
        StoreRequest::Journal(request) => {
            super::journal::execute(connection, *request);
        }
        #[cfg(test)]
        StoreRequest::Test(request) => super::sqlite_tests::execute(connection, request),
    }
}
