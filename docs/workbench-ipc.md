# Workbench external IPC v3

The single production `pi-acp-workbenchd` exposes `<storage.root>/workbench.sock` (0600, same-UID peer credentials). This is a trusted local-account API, not remote authentication or Telegram authorization. Clients and daemon must use the same protocol; v2 is rejected, not translated. The extension never starts a daemon or falls back to another socket.

## Frames and ownership

Requests are UTF-8 NDJSON with `version: 3`, a non-reused safe-integer `id`, `command` and, for mutations, an independent durable string `operation`. Unknown fields, internal Agent commands, malformed UTF-8 and unsupported versions fail closed. Frames are capped at 8 MiB; incomplete frames have a ten-second deadline. Connections have bounded ordinary/control/query admission (16/4/4), output buffering and subscriptions. Dropping a request observer does not roll back accepted work or release transaction ownership early.

```json
{"version":3,"id":1,"command":{"method":"create","harness":"Pi","cwd":"/absolute/workspace"},"operation":"example-create"}
{"version":3,"id":2,"command":{"method":"list"}}
{"version":3,"id":3,"command":{"method":"attach","session":"SESSION_ID"}}
```

Substitute actual returned IDs. Mutations return `type: reply` with the original typed `receipt`, never an event array or full transcript. Receipts include Created/Forked summaries, Loaded views, Accepted revisions and Removed identities. Reusing an operation with the identical command returns its original committed result, including after restart/removal. Reusing it with different arguments is rejected. A prompt receipt means acceptance, not turn completion. Never automatically retry an uncertain mutation on disconnect.

Queries return `type: query`, with `result: { kind, value }`. Errors have `type: error`, the request id, code and message. `image` has its dedicated `type: image` asset response. Query reads never append operation journal rows or start workers. Explicit load may create an owner and commit interruption recovery.

## Bounded queries

- `operation {operation}` is a read-only recovery query by durable ID, without a command body. It returns `kind: operation` and a tagged status: `unknown`, `uncertain`, `expired`, `completed {receipt}`, or `failed {message}`. A Started record is conservatively `uncertain`, including while work is live; it does not prove dispatch or completion. Unknown never authorizes automatic resubmission. Lookup does not allocate a receipt or start a provider. The extension stores at most 64 handle rows, never command bodies, and only queries them after reload.

- `inspect {session}` returns only the validated hot SessionView, not history or tool bodies. Cold inspect does not create an actor.
- `list {cursor?,limit?}` defaults to 50, maximum 100 summaries. Descending created sequence/keyset cursors freeze the initial maximum.
- `history {session,cursor?,limit?}` defaults to 100, maximum 200 headers, descending sequence pages returned in ascending order within each page. Cursors bind protocol version, session and immutable maximum boundary.
- `tools {session,turn,cursor?,limit?}` reads a bounded page of typed headers. Text/diff/resource bodies remain ContentRefs.
- `content {ref,offset,length?}` reads at most 64 KiB directly from the archive. Offset is a UTF-8 byte boundary; the end is trimmed to a valid boundary. The whole-content hash identifies the content; it does **not** independently authenticate an isolated slice. Full archive reads/writes and fork proof verify full identity/hash.
- `image {image: IMAGE_REF}` explicitly retrieves immutable archive bytes. Descriptor, hash, MIME signature, canonical base64 and decoded size are validated. Images have a 4 MiB raw limit; only the dedicated asset response contains base64. This is not a complete image decoder/sanitizer. No path, URI, remote URL or file-ID fallback exists.

Normal query pages and batches must fit their complete 1 MiB JSON envelope, views 512 KiB and inline text 16 KiB. A metadata row that cannot fit produces a typed TooLarge error rather than an endless empty page. Single content is capped at 64 MiB; integers must be JS-safe.

## Attach and revision batches

`attach {session}` registers broadcast observation before obtaining an atomic view/recent-history read. That query establishes the initial revision. Subsequent `type: batch` messages carry a CommitBatch with session, revision, optional replacement view, appended committed entry headers and tool updates. The actor commits once, updates its hot view and synchronously publishes exactly one batch before the next mailbox command. No-op commands do not advance revision.

The bounded subscription discards batches at or below its attached revision. Duplicate revisions are ignored; a gap/lag emits `resync_required` and terminates the connection. Clients reattach using a new snapshot and must not replay mutations. The desktop controller retries only cold observation/receipt queries with a single bounded-backoff reconnect task; Refresh also reattaches disconnected selections. Removal publishes a terminal batch using a persisted tombstone revision. `detach {session}` ends observation. There is no second persistent event log, snapshot polling or client domain reducer.

## Runtime safety

Cancellation first durably fences the old epoch with Cancelling, then performs ACP cancellation and physical worker join, and only then commits the terminal state and delivery intent. A failed initial commit leaves the live turn untouched; a failed final commit remains recoverable via explicit cancel/load. Late epochs cannot write. Fork uses source mutation-lane exclusion, bounded archive proof and revision-checked SQL adoption; provider message IDs are not native IDs. Ambiguous cuts are refused. Uncertain/unadopted remote effects remain visible, not successful rollback.

Archive rows/content, original operation receipts and Acked deliveries survive source deletion. Telegram turn intents freeze independent `delivery_entries` links in the finish transaction; subsequent source deletion cannot invalidate pending delivery.

See [VS Code/browser](workbench-vscode.md), [storage](workbench-storage.md), [Telegram](workbench-telegram.md) and [release](workbench-release.md). Strict v3 real-binary contracts, TS integration, browser and production artifact checks exercise this contract; synthetic peers do not prove live model/Bot behavior.
