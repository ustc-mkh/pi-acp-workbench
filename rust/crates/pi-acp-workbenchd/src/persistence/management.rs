use super::{database::StoreError, query};
use crate::domain::query::SafeInteger;
use crate::domain::{
    management::*,
    operation::OperationTicket,
    query::{CommandReceipt, SessionView},
    transition::Transition,
    SessionId,
};
use rusqlite::{params, Connection};
fn harness(h: &crate::domain::session::Harness) -> &'static str {
    match h {
        crate::domain::session::Harness::Pi => "Pi",
        crate::domain::session::Harness::Codex => "Codex",
        crate::domain::session::Harness::Claude => "Claude",
    }
}
fn encode<T: serde::Serialize>(v: &T) -> Result<String, StoreError> {
    super::database::encode(v)
}
pub(super) fn observe(
    db: &Connection,
    old: &SessionView,
    change: &Transition,
) -> Result<(), StoreError> {
    let view = &change.next;
    for entry in &change.append {
        if entry.role != crate::domain::transcript::EntryRole::User {
            continue;
        }
        let title: String = entry
            .text
            .text
            .chars()
            .filter(|c| !c.is_control())
            .take(48)
            .collect();
        db.execute("INSERT INTO session_metadata(session,title,source,attempted) VALUES(?1,?2,'fallback',0) ON CONFLICT(session) DO NOTHING",params![view.id.as_str(),if title.trim().is_empty(){"New task"}else{&title}])?;
    }
    // A turn exists independently of user entries (Pi may wake autonomously).
    if let Some(turn) = view
        .active_turn
        .as_ref()
        .filter(|turn| old.active_turn.as_ref() != Some(*turn))
    {
        let model = view
            .config
            .model
            .as_ref()
            .or(view.catalogue.current_model.as_ref())
            .map(|m| m.as_str())
            .unwrap_or("unknown");
        db.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at) VALUES(?1,?2,(SELECT created_seq FROM sessions WHERE id=?2),?3,?4,'inference',CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(id) DO NOTHING",params![format!("turn:{}:{}",view.id.as_str(),turn.as_str()),view.id.as_str(),harness(&view.harness),model])?;
    }
    if view.usage.reported
        && (view.usage.input_tokens != old.usage.input_tokens
            || view.usage.output_tokens != old.usage.output_tokens
            || !old.usage.reported
            || view.usage.cache_read_tokens != old.usage.cache_read_tokens
            || view.usage.cache_write_tokens != old.usage.cache_write_tokens)
    {
        if let Some(turn) = &view.active_turn {
            let model = view
                .config
                .model
                .as_ref()
                .or(view.catalogue.current_model.as_ref())
                .map(|m| m.as_str())
                .unwrap_or("unknown");
            db.execute("UPDATE usage_facts SET model=?2,input=?3,output=?4,cache_read=?5,cache_write=?6,source='acp_prompt_usage' WHERE id=?1",params![format!("turn:{}:{}",view.id.as_str(),turn.as_str()),model,view.usage.input_tokens as i64,view.usage.output_tokens as i64,view.usage.cache_read_tokens.map(|n|n as i64),view.usage.cache_write_tokens.map(|n|n as i64)])?;
        }
    }
    Ok(())
}
pub(super) fn save_model_config(
    tx: &Connection,
    h: &crate::domain::session::Harness,
    action: &ManagementAction,
) -> Result<(), StoreError> {
    if let ManagementAction::ModelConfig {
        model,
        hidden,
        price,
        multiplier,
        context_window,
        apply_context,
    } = action
    {
        let count: u32 = tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_settings WHERE harness=?1 AND model=?2)",
            params![harness(h), model],
            |r| r.get(0),
        )?;
        if count >= 1500 && !exists {
            return Err(StoreError::Invalid("model settings budget exceeded"));
        }
        tx.execute("INSERT INTO model_settings(harness,model,hidden,price,price_multiplier,context_override) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(harness,model) DO UPDATE SET hidden=excluded.hidden,price=excluded.price,price_multiplier=excluded.price_multiplier,context_override=CASE WHEN ?7 THEN excluded.context_override ELSE context_override END", params![harness(h),model,hidden,price.as_ref().map(encode).transpose()?,multiplier,if *apply_context { context_window.map(|n|n as i64) } else { None },apply_context])?;
    }
    Ok(())
}
pub(super) fn update(
    db: &mut Connection,
    session: &SessionId,
    action: &ManagementAction,
    ticket: Option<&OperationTicket>,
) -> Result<CommandReceipt, StoreError> {
    if !action.validate() {
        return Err(StoreError::Invalid("invalid settings"));
    }
    let tx = db.transaction()?;
    let view = query::view(&tx, session)?;
    match action {
        ManagementAction::Rename { title } => {
            tx.execute("INSERT INTO session_metadata(session,title,source,attempted) VALUES(?1,?2,'manual',1) ON CONFLICT(session) DO UPDATE SET title=excluded.title,source='manual',attempted=1",params![session.as_str(),title.trim()])?;
        }
        ManagementAction::Model {
            model,
            hidden,
            price,
        } => {
            let count: u32 =
                tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_settings WHERE harness=?1 AND model=?2)",
                params![harness(&view.harness), model],
                |r| r.get(0),
            )?;
            if count >= 1500 && !exists {
                return Err(StoreError::Invalid("model settings budget exceeded"));
            }
            tx.execute("INSERT INTO model_settings(harness,model,hidden,price) VALUES(?1,?2,?3,?4) ON CONFLICT(harness,model) DO UPDATE SET hidden=excluded.hidden,price=excluded.price",params![harness(&view.harness),model,hidden,price.as_ref().map(encode).transpose()?])?;
        }
        ManagementAction::ModelConfig { .. } => save_model_config(&tx, &view.harness, action)?,
        ManagementAction::Visibility {
            models,
            hidden,
            reset,
        } => {
            let count: u32 =
                tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
            if count.saturating_add(models.len() as u32) > 2000 {
                return Err(StoreError::Invalid("model settings budget exceeded"));
            }
            for model in models {
                tx.execute("INSERT INTO model_settings(harness,model,hidden) VALUES(?1,?2,?3) ON CONFLICT(harness,model) DO UPDATE SET hidden=excluded.hidden,price=CASE WHEN ?4 THEN NULL ELSE price END,price_multiplier=CASE WHEN ?4 THEN 1 ELSE price_multiplier END",params![harness(&view.harness),model,hidden,reset])?;
            }
            let count: u32 =
                tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
            if count > 1500 {
                return Err(StoreError::Invalid("model settings budget exceeded"));
            }
        }
        ManagementAction::Naming { policy, model } => {
            tx.execute(
                "UPDATE naming_settings SET policy=?1,model=?2 WHERE id=1",
                params![policy, model],
            )?;
        }
        _ => {
            return Err(StoreError::Invalid(
                "provider action requires explicit external execution",
            ))
        }
    }
    let receipt = CommandReceipt::Accepted {
        session: session.clone(),
        revision: view.revision,
    };
    if let Some(ticket) = ticket {
        super::journal::finish_in_transaction(&tx, ticket, &Ok(receipt.clone()))
            .map_err(|e| StoreError::Io(e.to_string()))?;
    }
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(receipt)
}
pub(super) fn models(
    db: &mut Connection,
    session: &SessionId,
    response: &ProviderModels,
) -> Result<(), StoreError> {
    if response.models.len() > 500 {
        return Err(StoreError::Invalid("model catalogue exceeds budget"));
    }
    let tx = db.transaction()?;
    let view = query::view(&tx, session)?;
    // Defaults are refreshed separately from user overrides/visibility.
    tx.execute(
        "UPDATE model_settings SET default_price=NULL,context_window=NULL WHERE harness=?1",
        [harness(&view.harness)],
    )?;
    for m in &response.models {
        if m.model.is_empty()
            || m.model.len() > 300
            || m.price.as_ref().is_some_and(|p| !p.valid())
            || m.context_window.is_some_and(|n| n == 0 || n > 100_000_000)
        {
            return Err(StoreError::Invalid("invalid provider model"));
        }
        tx.execute("INSERT INTO model_settings(harness,model,hidden,default_price,context_window) VALUES(?1,?2,0,?3,?4) ON CONFLICT(harness,model) DO UPDATE SET default_price=excluded.default_price,context_window=excluded.context_window",params![harness(&view.harness),m.model,m.price.as_ref().map(encode).transpose()?,m.context_window.map(|n|n as i64)])?;
    }
    let count: u32 = tx.query_row("SELECT count(*) FROM model_settings", [], |r| r.get(0))?;
    if count > 1500 {
        return Err(StoreError::Invalid("model settings budget exceeded"));
    }
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(())
}
pub(super) fn title_job(
    db: &mut Connection,
    session: &SessionId,
) -> Result<Option<String>, StoreError> {
    let tx = db.transaction()?;
    let (policy, model): (String, Option<String>) = tx.query_row(
        "SELECT policy,model FROM naming_settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let changed=tx.execute("UPDATE session_metadata SET attempted=1 WHERE session=?1 AND source='fallback' AND attempted=0",[session.as_str()])?;
    if changed == 1 && policy != "off" {
        let view = query::view(&tx, session)?;
        let selected = model
            .as_deref()
            .filter(|_| policy == "model")
            .or_else(|| {
                view.config
                    .model
                    .as_ref()
                    .or(view.catalogue.current_model.as_ref())
                    .map(|m| m.as_str())
            })
            .unwrap_or("unknown");
        tx.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at,source) VALUES(?1,?2,(SELECT created_seq FROM sessions WHERE id=?2),?3,?4,'title',CAST(strftime('%s','now') AS INTEGER)*1000,'missing_title') ON CONFLICT(id) DO NOTHING",params![format!("title:{}:0",session.as_str()),session.as_str(),harness(&view.harness),selected])?;
    }
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(if changed == 1 && policy != "off" {
        Some(if policy == "model" {
            model.unwrap_or_default()
        } else {
            String::new()
        })
    } else {
        None
    })
}
pub(super) fn title_result(
    db: &mut Connection,
    session: &SessionId,
    response: &TitleResponse,
) -> Result<(), StoreError> {
    if response.title.chars().count() > 80
        || response.title.chars().any(char::is_control)
        || response.records.len() > 16
    {
        return Err(StoreError::Invalid("invalid title response"));
    }
    let tx = db.transaction()?;
    let view = query::view(&tx, session)?;
    if !response.title.trim().is_empty() {
        tx.execute("UPDATE session_metadata SET title=?2,source='model' WHERE session=?1 AND source='fallback' AND attempted=1",params![session.as_str(),response.title.trim()])?;
    }
    for (i, r) in response.records.iter().enumerate() {
        if r.model.len() > 300
            || [r.input, r.output, r.cache_read, r.cache_write]
                .iter()
                .any(|v| *v > 9_007_199_254_740_991)
        {
            return Err(StoreError::Invalid("invalid title usage"));
        }
        tx.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at,input,output,cache_read,cache_write,source) VALUES(?1,?2,(SELECT created_seq FROM sessions WHERE id=?2),?3,?4,'title',CAST(strftime('%s','now') AS INTEGER)*1000,?5,?6,?7,?8,'pi_title') ON CONFLICT(id) DO UPDATE SET model=excluded.model,input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,source=excluded.source",params![format!("title:{}:{i}",session.as_str()),session.as_str(),harness(&view.harness),r.model,r.input as i64,r.output as i64,r.cache_read as i64,r.cache_write as i64])?;
    }
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(())
}
fn group(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageGroup> {
    Ok(UsageGroup {
        label: row.get(10)?,
        key: row.get(0)?,
        calls: row.get::<_, SafeInteger>(1)?.get(),
        missing: row.get::<_, SafeInteger>(2)?.get(),
        cache_missing: row.get::<_, SafeInteger>(3)?.get(),
        unpriced: row.get::<_, SafeInteger>(4)?.get(),
        input: row.get::<_, SafeInteger>(5)?.get(),
        output: row.get::<_, SafeInteger>(6)?.get(),
        cache_read: row.get::<_, SafeInteger>(7)?.get(),
        cache_write: row.get::<_, SafeInteger>(8)?.get(),
        estimated_usd: row.get(9)?,
    })
}
fn model_key(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect()
}
fn matched_defaults(models: &[ModelSetting], model: &str) -> (Option<Price>, Option<u64>) {
    let key = model_key(model);
    let mut candidates: Vec<_> = models
        .iter()
        .filter(|m| m.harness == crate::domain::session::Harness::Pi && model_key(&m.model) == key)
        .collect();
    let priority = |m: &&ModelSetting| {
        [
            "openai",
            "anthropic",
            "google",
            "mistral",
            "xai",
            "deepseek",
            "openai-codex",
            "groq",
        ]
        .iter()
        .position(|p| *p == m.model.split('/').next().unwrap_or(""))
        .unwrap_or(100)
    };
    candidates.sort_by_key(|m| (priority(m), &m.model));
    let price = candidates
        .iter()
        .filter(|m| priority(m) < 100)
        .find_map(|m| m.default_price.as_ref())
        .or_else(|| {
            candidates.iter().find_map(|m| {
                m.default_price.as_ref().filter(|p| {
                    [p.input, p.output, p.cache_read, p.cache_write]
                        .iter()
                        .any(|n| *n > 0.0)
                })
            })
        })
        .or_else(|| candidates.iter().find_map(|m| m.default_price.as_ref()))
        .cloned();
    let context = candidates.iter().find_map(|m| m.default_context_window);
    (price, context)
}
pub(super) fn read(db: &mut Connection, q: &ManagementQuery) -> Result<ManagementData, StoreError> {
    if !q.valid() {
        return Err(StoreError::Invalid("invalid statistics filter"));
    }
    let tx = db.transaction()?;
    let (naming_policy, title_model) = tx.query_row(
        "SELECT policy,model FROM naming_settings WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let models = {
        let mut statement=tx.prepare("SELECT m.harness,m.model,m.hidden,m.price,m.default_price,m.context_window,m.context_override,m.price_multiplier,c.state,c.error FROM model_settings m LEFT JOIN model_context_intents c ON m.harness='Pi' AND c.model=m.model ORDER BY m.harness,m.model LIMIT 1500")?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<SafeInteger>>(5)?.map(|n| n.get()),
                r.get::<_, Option<SafeInteger>>(6)?.map(|n| n.get()),
                r.get::<_, f64>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
            ))
        })?;
        let mut models = vec![];
        for row in rows {
            let (h, m, hidden, p, d, c, override_context, multiplier, context_state, context_error) =
                row?;
            models.push(ModelSetting {
                harness: serde_json::from_str(&format!("\"{h}\""))?,
                model: m,
                hidden,
                price: p.map(|s| serde_json::from_str(&s)).transpose()?,
                default_price: d.map(|s| serde_json::from_str(&s)).transpose()?,
                context_window: override_context.or(c),
                default_context_window: c,
                context_override: override_context,
                multiplier,
                context_state,
                context_error,
            });
        }
        models
    };
    let mut models = models;
    let defaults = models.clone();
    for model in &mut models {
        let (price, context) = matched_defaults(&defaults, &model.model);
        model.default_price = price.or(model.default_price.take());
        model.default_context_window = context.or(model.default_context_window);
        model.context_window = model.context_override.or(model.default_context_window);
    }
    let mut data = ManagementData {
        models,
        naming_policy,
        title_model,
        groups: vec![],
        totals: None,
        next_cursor: None,
    };
    if let Some(dimension) = &q.group {
        #[derive(serde::Serialize)]
        struct ResolvedPrice {
            harness: String,
            model: String,
            price: Option<Price>,
            multiplier: f64,
        }
        let mut prices: Vec<ResolvedPrice> = data
            .models
            .iter()
            .map(|m| ResolvedPrice {
                harness: harness(&m.harness).into(),
                model: m.model.clone(),
                price: m.price.clone().or(m.default_price.clone()),
                multiplier: m.multiplier,
            })
            .collect();
        let missing = tx.prepare("SELECT DISTINCT u.harness,u.model FROM usage_facts u LEFT JOIN model_settings m ON m.harness=u.harness AND m.model=u.model WHERE m.model IS NULL LIMIT 1500")?
            .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        for (h, model) in missing {
            let (price, _) = matched_defaults(&defaults, &model);
            prices.push(ResolvedPrice {
                harness: h,
                model,
                price,
                multiplier: 1.0,
            });
        }
        let prices = serde_json::to_string(&prices)?;
        // A bounded materialized SELECT keeps read-only readers cold and the join indexed.
        let cte = "WITH management_prices AS MATERIALIZED (SELECT json_extract(value,'$.harness') AS harness,json_extract(value,'$.model') AS model,json_extract(value,'$.price') AS price,json_extract(value,'$.multiplier') AS multiplier FROM json_each(?6))";
        let key = match dimension.as_str() {
            "model" => "u.harness || '/' || u.model",
            "session" => "u.session",
            "week" => "date(u.occurred_at/1000,'unixepoch','-6 days','weekday 1')",
            "month" => "strftime('%Y-%m',u.occurred_at/1000,'unixepoch')",
            _ => "date(u.occurred_at/1000,'unixepoch')",
        };
        let base="FROM usage_facts u LEFT JOIN management_prices m ON m.harness=u.harness AND m.model=u.model LEFT JOIN session_metadata n ON n.session=u.session WHERE u.occurred_at>=?1 AND u.occurred_at<=?2 AND (?3 IS NULL OR u.session=?3) AND (?4 IS NULL OR u.model=?4)";
        let aggregate="count(*),COALESCE(sum(u.input IS NULL OR u.output IS NULL),0),COALESCE(sum(u.cache_read IS NULL OR u.cache_write IS NULL),0),COALESCE(sum(m.price IS NULL),0),COALESCE(sum(u.input),0),COALESCE(sum(u.output),0),COALESCE(sum(u.cache_read),0),COALESCE(sum(u.cache_write),0),COALESCE(sum((COALESCE(u.input,0)*json_extract(m.price,'$.input')+COALESCE(u.output,0)*json_extract(m.price,'$.output')+COALESCE(u.cache_read,0)*json_extract(m.price,'$.cache_read')+COALESCE(u.cache_write,0)*json_extract(m.price,'$.cache_write'))*COALESCE(m.multiplier,1)/1000000.0),0.0)";
        let from = q.from.unwrap_or(0) as i64;
        let to = q.to.unwrap_or(8_640_000_000_000_000) as i64;
        let session = q.session.as_ref().map(|s| s.as_str());
        data.totals = Some(tx.query_row(
            &format!("{cte} SELECT 'total',{aggregate},NULL {base}"),
            params![from, to, session, q.model, None::<String>, &prices],
            group,
        )?);
        let label = if dimension == "session" {
            "'#' || max(u.session_number) || ' ' || COALESCE(max(n.title),'Archived session')"
        } else {
            "NULL"
        };
        let sql=format!("{cte} SELECT {key} AS group_key,{aggregate},{label} {base} GROUP BY group_key HAVING group_key>?5 ORDER BY group_key LIMIT 101");
        let mut statement = tx.prepare(&sql)?;
        data.groups = statement
            .query_map(
                params![
                    from,
                    to,
                    session,
                    q.model,
                    q.cursor.as_deref().unwrap_or(""),
                    &prices
                ],
                group,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if data.groups.len() > 100 {
            data.groups.truncate(100);
            data.next_cursor = data.groups.last().map(|g| g.key.clone());
        }
    }
    crate::diagnostics::sqlite_commit(tx)?;
    Ok(data)
}
