-- One database, no cascading archive/receipt deletion. All lengths/sequences
-- are bounded to integers exactly representable by the public JS protocol.
CREATE TABLE store_meta (
    key TEXT PRIMARY KEY CHECK (key IN ('created_seq', 'delivery_seq', 'activity_seq')),
    value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO store_meta VALUES ('created_seq', 0), ('delivery_seq', 0), ('activity_seq', 0);
CREATE TABLE history_clear_jobs (
    job TEXT PRIMARY KEY,
    filter_json TEXT NOT NULL,
    active INTEGER NOT NULL,
    pending_deliveries INTEGER NOT NULL
) STRICT;
CREATE TABLE history_clear_targets (
    job TEXT NOT NULL REFERENCES history_clear_jobs(job),
    session TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','removed','failed')),
    error TEXT,
    PRIMARY KEY(job,session)
) STRICT;
CREATE INDEX history_clear_pending ON history_clear_targets(job,state,session);
CREATE TABLE removed_sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    title TEXT CHECK (title IS NULL OR length(title)<=320)
) STRICT;
CREATE TABLE sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    created_seq INTEGER NOT NULL UNIQUE CHECK (created_seq BETWEEN 1 AND 9007199254740991),
    activity_seq INTEGER NOT NULL DEFAULT 0 CHECK (activity_seq BETWEEN 0 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    last_entry_seq INTEGER NOT NULL CHECK (last_entry_seq BETWEEN 0 AND 9007199254740991),
    harness TEXT NOT NULL CHECK (harness IN ('Pi', 'Codex', 'Claude')),
    cwd TEXT NOT NULL CHECK (length(cwd) > 0),
    status_json TEXT NOT NULL CHECK (json_valid(status_json) AND COALESCE(json_extract(status_json, '$') IN ('Idle', 'Running', 'Waiting', 'Cancelling') OR (json_type(status_json) = 'object' AND json_type(status_json, '$.Failed') = 'text'), 0)),
    hot_state_json TEXT NOT NULL CHECK (json_valid(hot_state_json) AND json_type(hot_state_json, '$.transcript') IS NULL)
) STRICT;
CREATE TABLE session_metadata (
    session TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title)<=320),
    source TEXT NOT NULL CHECK(source IN ('fallback','manual','model')),
    attempted INTEGER NOT NULL CHECK(attempted IN (0,1))
) STRICT;
CREATE TABLE naming_settings (id INTEGER PRIMARY KEY CHECK(id=1),policy TEXT NOT NULL,model TEXT) STRICT;
INSERT INTO naming_settings VALUES(1,'follow',NULL);
CREATE TABLE provider_preferences (harness TEXT PRIMARY KEY, config_json TEXT NOT NULL) STRICT;
CREATE TABLE model_settings (
    harness TEXT NOT NULL, model TEXT NOT NULL CHECK(length(model)<=300), hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
    price TEXT CHECK(price IS NULL OR json_valid(price)), default_price TEXT CHECK(default_price IS NULL OR json_valid(default_price)),context_window INTEGER,
    price_multiplier REAL NOT NULL DEFAULT 1 CHECK(price_multiplier >= 0 AND price_multiplier <= 1000000), context_override INTEGER CHECK(context_override IS NULL OR (context_override > 0 AND context_override <= 100000000)),
    PRIMARY KEY(harness,model)
) STRICT;
CREATE TABLE model_context_clock (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO model_context_clock VALUES(1,0);
CREATE TABLE model_context_intents (
    model TEXT PRIMARY KEY CHECK(length(model) BETWEEN 1 AND 300),
    revision INTEGER NOT NULL UNIQUE CHECK(revision BETWEEN 1 AND 9007199254740991),
    context_window INTEGER CHECK(context_window IS NULL OR (context_window > 0 AND context_window <= 100000000)),
    state TEXT NOT NULL CHECK(state IN ('pending','applied')), error TEXT
) STRICT;
CREATE TABLE usage_facts (
    id TEXT PRIMARY KEY, session TEXT NOT NULL, session_number INTEGER NOT NULL DEFAULT 0, harness TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
    occurred_at INTEGER NOT NULL, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, source TEXT NOT NULL DEFAULT 'missing'
) STRICT;
CREATE INDEX usage_date ON usage_facts(occurred_at,session,model);
CREATE INDEX usage_model ON usage_facts(model,occurred_at);
CREATE INDEX usage_session ON usage_facts(session,occurred_at);
CREATE TABLE contents (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK (kind IN ('Text', 'ToolText', 'ToolDiff', 'ToolResource', 'Image')),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 67108864 AND (kind != 'Image' OR bytes BETWEEN 1 AND 4194304)),
    data BLOB NOT NULL CHECK (length(data) = bytes),
    image_ref_json TEXT CHECK (image_ref_json IS NULL OR (json_valid(image_ref_json) AND length(image_ref_json) <= 1024)),
    CHECK ((kind = 'Image' AND image_ref_json IS NOT NULL) OR (kind != 'Image' AND image_ref_json IS NULL))
) STRICT;
CREATE TABLE archive_roots (
    content_id TEXT NOT NULL REFERENCES contents(id),
    reason TEXT NOT NULL CHECK(reason IN ('text_archive','delivery')),
    PRIMARY KEY(content_id,reason)
) STRICT;
CREATE TABLE entries (
    entry_id TEXT PRIMARY KEY CHECK (length(entry_id) BETWEEN 1 AND 200),
    turn TEXT NOT NULL CHECK (length(turn) BETWEEN 1 AND 200),
    role TEXT NOT NULL CHECK (role IN ('User', 'Agent', 'Thought', 'Tool')),
    message TEXT,
    content_id TEXT NOT NULL REFERENCES contents(id),
    image_id TEXT REFERENCES contents(id),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
) STRICT;
CREATE INDEX entries_turn_role ON entries(turn, role, entry_id);
CREATE TABLE session_entries (
    session TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
    entry_id TEXT NOT NULL REFERENCES entries(entry_id),
    PRIMARY KEY (session, seq), UNIQUE (session, entry_id)
) STRICT;
CREATE TABLE tools (
    session TEXT NOT NULL REFERENCES sessions(id),
    turn TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    header_json TEXT NOT NULL CHECK (json_valid(header_json) AND COALESCE(json_extract(header_json, '$.status') IN ('Pending', 'InProgress', 'Completed', 'Failed'), 0)),
    PRIMARY KEY (session, turn, tool_id)
) STRICT;
CREATE TABLE turn_diffs (
    session TEXT NOT NULL,
    turn TEXT NOT NULL,
    diff_json TEXT NOT NULL CHECK (json_valid(diff_json) AND length(diff_json) <= 33554432),
    PRIMARY KEY(session,turn),
    FOREIGN KEY(session) REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE turn_outcomes (
    session TEXT NOT NULL,
    turn TEXT NOT NULL,
    revision INTEGER NOT NULL,
    files INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','cancelled','failed')),
    diff_status TEXT NOT NULL CHECK(diff_status IN ('complete','partial','unavailable')),
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    PRIMARY KEY(session,turn),
    UNIQUE(session,revision)
) STRICT;
CREATE TABLE operations (
    operation TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK (status IN ('Started', 'Completed', 'Failed', 'Tombstone')),
    result BLOB,
    checksum TEXT CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
    CHECK ((status IN ('Completed', 'Failed') AND result IS NOT NULL AND checksum IS NOT NULL) OR (status IN ('Started', 'Tombstone') AND result IS NULL AND checksum IS NULL))
) STRICT;
CREATE TABLE deliveries (
    delivery_id TEXT PRIMARY KEY,
    order_seq INTEGER NOT NULL UNIQUE CHECK (order_seq BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    target_key TEXT NOT NULL,
    target_json TEXT NOT NULL CHECK (json_valid(target_json)),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    status TEXT NOT NULL CHECK (status IN ('Pending', 'Acked')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 4294967295),
    next_retry INTEGER NOT NULL DEFAULT 0 CHECK (next_retry BETWEEN 0 AND 9007199254740991),
    last_failure TEXT CHECK (last_failure IN ('Transport', 'RateLimited', 'InvalidTarget', 'PayloadUnavailable'))
) STRICT;
CREATE TABLE delivery_entries (
    delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
    seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
    entry_id TEXT NOT NULL REFERENCES entries(entry_id),
    PRIMARY KEY (delivery_id, seq)
) STRICT;
CREATE TABLE telegram_history_exports (
    export_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id)
) STRICT;
CREATE INDEX telegram_history_exports_delivery ON telegram_history_exports(delivery_id);
-- One actual destination per acknowledged automatic turn, not per text delta.
CREATE TABLE telegram_turn_receipts (
    delivery_id TEXT PRIMARY KEY REFERENCES deliveries(delivery_id),
    bot_id INTEGER NOT NULL,
    chat INTEGER NOT NULL,
    thread INTEGER NOT NULL,
    session TEXT NOT NULL
) STRICT;
CREATE INDEX deliveries_retry ON deliveries(status, next_retry);
CREATE INDEX deliveries_topic_order ON deliveries(target_key, status, order_seq) WHERE status='Pending';
CREATE TABLE telegram_meta (
    bot_id INTEGER PRIMARY KEY CHECK (bot_id >= 0),
    offset INTEGER NOT NULL CHECK (offset BETWEEN 0 AND 9007199254740991),
    owner_json TEXT NOT NULL CHECK (json_valid(owner_json))
) STRICT;
CREATE TABLE telegram_prompt_attempts (
    bot_id INTEGER NOT NULL,
    update_id INTEGER NOT NULL,
    operation TEXT NOT NULL,
    PRIMARY KEY(bot_id,update_id),
    FOREIGN KEY(bot_id,update_id) REFERENCES telegram_inbox(bot_id,update_id)
) STRICT;
CREATE INDEX telegram_prompt_operation ON telegram_prompt_attempts(operation);
CREATE TABLE telegram_history_cursors (
    bot_id INTEGER NOT NULL REFERENCES telegram_meta(bot_id),
    chat INTEGER NOT NULL,
    thread INTEGER NOT NULL CHECK (thread >= 0),
    session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL CHECK (last_seq BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (bot_id,chat,thread,session)
) STRICT;
CREATE INDEX telegram_history_session ON telegram_history_cursors(session);
CREATE TABLE telegram_bindings (
    bot_id INTEGER NOT NULL REFERENCES telegram_meta(bot_id),
    chat INTEGER NOT NULL,
    thread INTEGER NOT NULL CHECK (thread >= 0),
    session TEXT NOT NULL,
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    PRIMARY KEY (bot_id, chat, thread), UNIQUE (bot_id, session)
) STRICT;
CREATE TABLE telegram_topic_preferences (
    bot_id INTEGER NOT NULL REFERENCES telegram_meta(bot_id),
    chat INTEGER NOT NULL CHECK (chat != 0),
    thread INTEGER NOT NULL CHECK (thread >= 0),
    notifications INTEGER NOT NULL CHECK (notifications IN (0, 1)),
    silent INTEGER NOT NULL CHECK (silent IN (0, 1)),
    PRIMARY KEY (bot_id, chat, thread)
) STRICT;
CREATE TABLE telegram_inbox (
    bot_id INTEGER NOT NULL REFERENCES telegram_meta(bot_id),
    update_id INTEGER NOT NULL CHECK (update_id BETWEEN 0 AND 9007199254740991),
    command_json TEXT NOT NULL CHECK (json_valid(command_json)),
    operation TEXT NOT NULL,
    callback_ref TEXT,
    status TEXT NOT NULL CHECK (status IN ('Pending', 'Started', 'Completed', 'Failed', 'Uncertain')),
    outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
    PRIMARY KEY (bot_id, update_id)
) STRICT;
CREATE INDEX telegram_inbox_pending ON telegram_inbox(bot_id, status, update_id);
CREATE INDEX telegram_inbox_pending_ref ON telegram_inbox(bot_id, callback_ref) WHERE status = 'Pending';
CREATE TABLE telegram_callbacks (
    bot_id INTEGER NOT NULL REFERENCES telegram_meta(bot_id),
    key TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('Answer', 'Control')),
    binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
    expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
    used_by INTEGER CHECK (used_by BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (bot_id, key)
) STRICT;
CREATE INDEX telegram_callbacks_expiry ON telegram_callbacks(bot_id, action_kind, expires_at);
CREATE TABLE telegram_effects (
    effect_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('Started', 'Completed', 'Failed', 'Uncertain')),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
) STRICT;
PRAGMA user_version = 3;

PRAGMA application_id = 1346978609;
