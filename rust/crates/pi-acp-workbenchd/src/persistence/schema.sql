-- One database, no cascading archive/receipt deletion. All lengths/sequences
-- are bounded to integers exactly representable by the public JS protocol.
CREATE TABLE store_meta (
    key TEXT PRIMARY KEY CHECK (key IN ('created_seq', 'delivery_seq', 'activity_seq')),
    value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO store_meta VALUES ('created_seq', 0), ('delivery_seq', 0), ('activity_seq', 0);
CREATE TABLE removed_sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991)
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
CREATE TABLE contents (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK (kind IN ('Text', 'ToolText', 'ToolDiff', 'ToolResource', 'Image')),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 67108864 AND (kind != 'Image' OR bytes BETWEEN 1 AND 4194304)),
    data BLOB NOT NULL CHECK (length(data) = bytes),
    image_ref_json TEXT CHECK (image_ref_json IS NULL OR (json_valid(image_ref_json) AND length(image_ref_json) <= 1024)),
    CHECK ((kind = 'Image' AND image_ref_json IS NOT NULL) OR (kind != 'Image' AND image_ref_json IS NULL))
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
CREATE INDEX deliveries_topic_order ON deliveries(target_key, status, order_seq);
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
