//! Connection creation and schema initialization run only on the DB OS thread.
use super::{database::StoreError, format};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::Duration,
};

const SCHEMA: &str = include_str!("schema.sql");
const TABLES: &[&str] = &[
    "turn_outcomes",
    "history_clear_jobs",
    "history_clear_targets",
    "archive_roots",
    "store_meta",
    "removed_sessions",
    "sessions",
    "session_metadata",
    "naming_settings",
    "model_settings",
    "provider_preferences",
    "usage_facts",
    "turn_diffs",
    "contents",
    "entries",
    "session_entries",
    "tools",
    "operations",
    "deliveries",
    "delivery_entries",
    "telegram_meta",
    "telegram_bindings",
    "telegram_topic_preferences",
    "telegram_history_cursors",
    "telegram_prompt_attempts",
    "telegram_turn_receipts",
    "telegram_history_exports",
    "telegram_inbox",
    "telegram_callbacks",
    "telegram_effects",
];

pub(super) fn open(root: &Path) -> Result<Connection, StoreError> {
    let initializing = format::prepare_database(root)?;
    let path = root.join("workbench.sqlite3");
    for name in [
        "workbench.sqlite3",
        "workbench.sqlite3-wal",
        "workbench.sqlite3-shm",
        "workbench.sqlite3-journal",
    ] {
        match fs::symlink_metadata(root.join(name)) {
            Ok(meta) if !meta.is_file() => {
                return Err(StoreError::Invalid("database files must be regular"))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    if initializing && !path.try_exists()? {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?
            .sync_all()?;
    }
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 3 {
        let count: i64 = connection.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if !initializing || version != 0 || count != 0 {
            return Err(StoreError::Invalid(
                "unsupported or incomplete database schema",
            ));
        }
    }
    connection.busy_timeout(Duration::from_millis(5000))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    if version == 0 {
        let tx = connection.transaction()?;
        tx.execute_batch(SCHEMA)?;
        crate::diagnostics::sqlite_commit(tx)?;
    }
    let journal: String = connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    let synchronous: u32 = connection.pragma_query_value(None, "synchronous", |row| row.get(0))?;
    let foreign_keys: u32 =
        connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    let busy: u32 = connection.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if journal != "wal" || synchronous != 2 || foreign_keys != 1 || busy != 5000 || version != 3 {
        return Err(StoreError::Invalid(
            "required SQLite PRAGMA was not applied",
        ));
    }
    for name in TABLES {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::Invalid("required database table is missing"));
        }
    }
    connection
        .prepare("SELECT bot_id,chat,thread,notifications,silent FROM telegram_topic_preferences LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported Telegram preferences schema"))?;
    connection
        .prepare(
            "SELECT delivery_id,bot_id,chat,thread,session FROM telegram_turn_receipts LIMIT 0",
        )
        .map_err(|_| StoreError::Invalid("unsupported Telegram turn receipt schema"))?;
    for statement in [
        "SELECT session,title,source,attempted FROM session_metadata LIMIT 0",
        "SELECT policy,model FROM naming_settings WHERE id=1",
        "SELECT harness,config_json FROM provider_preferences LIMIT 0",
        "SELECT harness,model,hidden,price,default_price,context_window FROM model_settings LIMIT 0",
        "SELECT id,session,session_number,harness,model,kind,occurred_at,input,output,cache_read,cache_write,source FROM usage_facts LIMIT 0",
    ] {
        connection.prepare(statement).map_err(|_|StoreError::Invalid("unsupported management schema"))?;
    }
    connection
        .prepare("SELECT session,turn,diff_json FROM turn_diffs LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported turn diff schema"))?;
    connection
        .prepare("SELECT activity_seq FROM sessions LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported activity-order schema"))?;
    connection
        .prepare("SELECT value FROM store_meta WHERE key='activity_seq'")
        .map_err(|_| StoreError::Invalid("unsupported activity sequence"))?;
    connection
        .prepare("SELECT export_id,delivery_id FROM telegram_history_exports LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported Telegram history export schema"))?;
    connection
        .prepare("SELECT bot_id,chat,thread,session,last_seq FROM telegram_history_cursors LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported Telegram history schema"))?;
    connection
        .prepare("SELECT action_kind FROM telegram_callbacks LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported Telegram callback schema"))?;
    connection
        .prepare("SELECT bot_id,update_id,operation FROM telegram_prompt_attempts LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported Telegram queue schema"))?;
    // No migration or format guessing for pre-release v3 roots lacking the
    // immutable image descriptor. Such roots must be recreated explicitly.
    connection
        .prepare("SELECT image_ref_json FROM contents LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported contents schema"))?;
    let delivery_index = connection
        .prepare("PRAGMA index_info(deliveries_topic_order)")?
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<Result<Vec<_>, _>>()?;
    let delivery_index_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='index' AND name='deliveries_topic_order'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if delivery_index != ["target_key", "status", "order_seq"]
        || delivery_index_sql.as_deref() != Some("CREATE INDEX deliveries_topic_order ON deliveries(target_key, status, order_seq) WHERE status='Pending'")
    {
        return Err(StoreError::Invalid("unsupported delivery index"));
    }
    connection
        .prepare("SELECT revision FROM deliveries LIMIT 0")
        .map_err(|_| StoreError::Invalid("unsupported delivery schema"))?;
    let inbox_index = connection
        .prepare("PRAGMA index_info(telegram_inbox_pending)")?
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<Result<Vec<_>, _>>()?;
    if inbox_index != ["bot_id", "status", "update_id"] {
        return Err(StoreError::Invalid("unsupported Telegram inbox index"));
    }
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(StoreError::Invalid("SQLite quick_check failed"));
    }
    let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.query([])?.next()?.is_some() {
        return Err(StoreError::Invalid("SQLite foreign key integrity failed"));
    }
    drop(foreign_keys);
    if initializing {
        format::complete_database(root)?;
    }
    Ok(connection)
}

/// Readers never initialize schema, change journal mode or run maintenance.
pub(super) fn open_reader(root: &Path) -> Result<Connection, StoreError> {
    let connection = Connection::open_with_flags(
        root.join("workbench.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_millis(5000))?;
    connection.pragma_update(None, "query_only", true)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 3 {
        return Err(StoreError::Invalid("unsupported readonly schema"));
    }
    Ok(connection)
}
