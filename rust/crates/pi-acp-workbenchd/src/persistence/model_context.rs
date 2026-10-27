//! Desired state is durable before a Pi profile can be modified. Never replays prompts.
use super::{database::StoreError, query};
use crate::domain::{management::*, query::SafeInteger, session::Harness, SessionId};
use rusqlite::{params, Connection, OptionalExtension};
pub(super) fn stage(
    db: &mut Connection,
    session: &SessionId,
    action: &ManagementAction,
) -> Result<ContextIntent, StoreError> {
    if !action.validate() {
        return Err(StoreError::Invalid("invalid context settings"));
    }
    let (model, context_window) = match action {
        ManagementAction::Context {
            model,
            context_window,
        }
        | ManagementAction::ModelConfig {
            model,
            context_window,
            apply_context: true,
            ..
        } => (model, context_window),
        _ => return Err(StoreError::Invalid("not a context projection")),
    };
    let tx = db.transaction()?;
    let view = query::view(&tx, session)?;
    if view.harness != Harness::Pi {
        return Err(StoreError::Invalid("only Pi has a context profile"));
    }
    super::management::save_model_config(&tx, &view.harness, action)?;
    if matches!(action, ManagementAction::Context { .. }) {
        tx.execute("INSERT INTO model_settings(harness,model,hidden,context_override) VALUES('Pi',?1,0,?2) ON CONFLICT(harness,model) DO UPDATE SET context_override=excluded.context_override",params![model,context_window.map(|n|n as i64)])?;
    }
    let count: u32 = tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
    if count > 1500 {
        return Err(StoreError::Invalid("model settings budget exceeded"));
    }
    let revision: u64 = tx.query_row(
        "UPDATE model_context_clock SET revision=revision+1 WHERE id=1 RETURNING revision",
        [],
        |r| r.get::<_, SafeInteger>(0).map(|v| v.get()),
    )?;
    tx.execute("INSERT INTO model_context_intents(model,revision,context_window,state) VALUES(?1,?2,?3,'pending') ON CONFLICT(model) DO UPDATE SET revision=excluded.revision,context_window=excluded.context_window,state='pending',error=NULL",params![model,revision as i64,context_window.map(|n|n as i64)])?;
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(ContextIntent {
        revision,
        model: model.clone(),
        context_window: *context_window,
    })
}
pub(super) fn snapshot(db: &mut Connection) -> Result<ContextSnapshot, StoreError> {
    let tx = db.transaction()?;
    let revision: u64 = tx.query_row(
        "SELECT revision FROM model_context_clock WHERE id=1",
        [],
        |r| r.get::<_, SafeInteger>(0).map(|v| v.get()),
    )?;
    let pending=tx.prepare("SELECT revision,model,context_window FROM model_context_intents WHERE state='pending' ORDER BY revision LIMIT 17")?
        .query_map([],|r|Ok(ContextIntent{revision:r.get::<_,SafeInteger>(0)?.get(),model:r.get(1)?,context_window:r.get::<_,Option<SafeInteger>>(2)?.map(|v|v.get())}))?.collect::<Result<Vec<_>,_>>()?;
    tx.commit()?;
    Ok(ContextSnapshot { revision, pending })
}
pub(super) fn settle(
    db: &mut Connection,
    revision: u64,
    error: Option<&str>,
) -> Result<(), StoreError> {
    let tx = db.transaction()?;
    let found: Option<String> = tx
        .query_row(
            "SELECT state FROM model_context_intents WHERE revision=?1",
            [revision as i64],
            |r| r.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(StoreError::Conflict);
    }
    tx.execute(
        "UPDATE model_context_intents SET state=?2,error=?3 WHERE revision=?1",
        params![
            revision as i64,
            if error.is_some() {
                "pending"
            } else {
                "applied"
            },
            error.map(|e| e.chars().take(300).collect::<String>())
        ],
    )?;
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(())
}
