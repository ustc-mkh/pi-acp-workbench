# Explicit offline storage maintenance

The **same `pi-acp-workbenchd` binary** provides maintenance subcommands. They do not start the runtime, provider workers, IPC listener or Telegram/network client, and do not read account configuration. All require `--confirm`, a canonical absolute non-root directory, an existing exact format-3 marker and the **same exclusive `flock` lease** as the host. A persistent `.workbench.lock` is normal: **never remove it to bypass a lock**. A live host is excluded even before its socket exists. An unlocked persistent lock file does not prevent maintenance.

Maintenance refuses any socket, symlink (including dangling links), FIFO or other special file in the source tree. A leftover `workbench.sock` after process loss requires independent operator inspection; it is not silently deleted. These checks protect against accidental path traversal, not a hostile process running as the same Unix account and rewriting directories concurrently. Stop the service, prevent automatic restarts and restrict access before maintenance.

Usage/model management requires `usage_facts` (stable per-turn/title identity, date/model/session indexes, NULL means missing), `model_settings` (at most 1500 rows of overrides/defaults/visibility/context), `session_metadata` (title/source/attempted), and singleton `naming_settings`. These are in the same SQLite file. Local settings changes and terminal receipts commit in one transaction; readers return SQL aggregates, not all records. Single-session removal cascades its live title/Diff but intentionally retains usage/number facts and operation/delivery identities; it is not an account-wide statistics purge. No native-history usage backfill, dual-write preferences file, or automatic old-root migration is added. Startup validates the required columns, including `usage_facts.session_number`; the development format-3 label does not authorize an earlier schema shape. Preserve binary/root together. Details: [model/usage management](workbench-management.md).

Workspace reviews also require `turn_diffs(session,turn,diff_json)`: immutable bounded workspace snapshots, independent of provider tool patches. Summary/content queries use the fixed readers. The row belongs to its live session and is removed by an SQL foreign-key cascade when that session is explicitly removed; it is not needed for retained Telegram delivery manifests. No pending/incomplete snapshot is reconstructed after host loss. Saved text may contain sensitive source; SQLite/WAL deletion is not secure erasure. See [workspace Diff/undo](turn-diff.md).

The current pre-release schema includes required `telegram_topic_preferences(bot_id,chat,thread,notifications,silent)` and `telegram_callbacks.action_kind` columns, plus typed Answer/Control callback bodies and `telegram_history_cursors(bot_id,chat,thread,session,last_seq)` / `telegram_turn_receipts(delivery_id,bot_id,chat,thread,session)`. Roots created before that schema shape are rejected, not upgraded or reset, despite sharing the development format-3 envelope. Preserve the previous binary/root together; use an isolated fresh root for current acceptance. Typed Telegram GC does not remove topic preferences; resetting both preferences to their defaults releases their bounded row explicitly.

Explicit history exports atomically freeze their request receipt, reserve existing outbox intents and advance a bounded per-topic/session cursor. Cursor rows are capped at 4096 per bot and cascade only when their owning session is explicitly removed; immutable archives, already accepted export intents and delivery tombstones remain. Typed GC does not reset live history cursors or remove export dedup identities. These cursors track **durably planned**, not remotely confirmed, exports; Pending outbox work remains responsible for retry. Completed Turn ack and its actual Telegram destination commit atomically as one small receipt row. It references the existing immutable manifest, not a new per-entry/per-part ledger; muted/skipped acknowledgements are not delivery evidence. These receipts survive source removal and remain with delivery tombstones. History reservation and sending both check completed same-topic Turn evidence; Turn rendering checks explicit history acks in batches of at most 100 indexed IDs. Missing required history/receipt tables or columns fail closed without migration/reset.

## Invocation

Build the daemon first for source-tree use:

```sh
npm run build:workbenchd
npm run workbench:storage -- export --root /absolute/canonical/data \
  --destination /absolute/existing-parent/new-export --confirm
```

The npm script is only a launcher. Its default is `rust/target/debug/pi-acp-workbenchd`; set `WORKBENCH_STORAGE_BINARY=/absolute/path/pi-acp-workbenchd` for another build. Production packages need no Node maintenance helper:

```sh
./pi-acp-workbenchd storage export --root /absolute/canonical/data \
  --destination /absolute/existing-parent/new-export --confirm
```

## Export

Export copies exact bytes, excludes the lease inode, and creates `EXPORT-MANIFEST.json` containing source, format version, file paths, sizes and SHA-256 hashes. Files are copied with bounded buffers, private directories/files and no overwrite. The destination parent must exist. Canonical overlap checks reject aliases into the source. Symlinks and special files are rejected before destination creation. The lease is held until copy, manifest and fsync complete. A failed export is left for inspection and is not reported successful; no recursive failure cleanup deletes operator-added files.

Export is a byte-level backup, not a format migration or a guarantee that every stored record is valid. Keep exports private: they contain conversations and may contain user-supplied sensitive content.

## GC: typed Telegram compaction only

```sh
./pi-acp-workbenchd storage gc --root /absolute/canonical/data --confirm
```

GC uses the database executor and one SQLite transaction to compact typed Telegram tables under the storage lease:

- Completed inbox records may be removed. The durable update offset remains unchanged, so an old update cannot execute again after restart.
- Expired callbacks may be removed **only if no pending inbox record references them**.
- Unexpired consumed callbacks remain to reject repeated clicks. Pending answers retain their exact consumed callback receipt even after expiry.
- The transaction commits all deletions together; failed writes do not publish a partial state. Repeated GC is idempotent.

Callbacks with no expiry (`u64::MAX`) are deliberately retained even if consumed. Therefore this GC does **not** eliminate the 4096-binding cap for indefinitely retained interactions. Reclaiming those keys safely requires additional typed session/interaction/outbox liveness evidence; it is still an open retention-policy task, not permission to reset offsets or discard receipts.

Online menu registration separately reclaims at most 128 expired **Control** callbacks per registration, protecting Pending inbox references and leaving Answer callbacks to offline typed GC. Menu controls are limited to 3072 rows within the total 4096 callback budget, preserving authorization headroom; reaching a limit gives a text-command fallback, not a new sender or bypass queue. Immutable menu replies/keys survive delivery retry without rebuilding their command snapshot.

The JSON summary reports `removed_inbox` and `removed_callbacks`. Missing Telegram records are a no-op; corrupt/unknown database or storage versions fail closed.

**General archive/operation/delivery GC is not implemented.** Format 3 stores session headers, entries, tools, content/images, operation receipts, delivery intents/manifests and Telegram records in `workbench.sqlite3`, with WAL and `synchronous=FULL`. This is incremental relational storage, not a JSON history directory or full replay at startup. The earlier JavaScript filename/string-reference scan is not used: it cannot establish safe reachability. Content/image orphans, receipts, delivery acknowledgement tombstones and admission sequence high-water are retained. No age threshold or filename guess authorizes their deletion. A future implementation requires a validated typed root graph plus crash-safe high-water/dedup retention. Export retains all database/WAL sidecars present while the host is offline; do not omit WAL files from a manual backup.

## Reset: marker-only roots

```sh
./pi-acp-workbenchd storage reset --root /absolute/canonical/marker-only-data --confirm
```

Reset refuses any contents besides `storage-format.json` and the persistent `.workbench.lock`. It removes only the format marker, **retaining the directory and stable lock inode**. Removing/replacing that inode while another process has opened it could create two independent leases; reset must never do that. A later normal host start can initialize the now marker-only root safely. A data-bearing or unversioned directory is never reset or migrated.

All tests use isolated temporary roots. Coverage includes cross-process host-compatible lock exclusion, unlocked persistent locks, byte/hash export, canonical overlap, symlink refusal, marker-only reset, corrupted Telegram state, pending callback protection, offset/restart deduplication and compaction failure preservation. This is not live-provider/Bot acceptance, full image decoding or a complete storage retention policy.
