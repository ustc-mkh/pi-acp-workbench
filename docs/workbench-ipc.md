# Workbench external IPC v2

This is the new external adapter, not a daemon-to-daemon service API. It binds `STORAGE_ROOT/workbench.sock` inside the `pi-acp-workbenchd` process and dispatches directly to its `WorkbenchApp`/actors. The default local VS Code/browser build now uses this protocol directly (`docs/workbench-vscode.md`), without the old ACP-shaped facade or socket client. Legacy source/tests and release/service packaging paths remain pending deletion/conversion; this is not final rewrite cutover.

## Lifecycle and storage

```sh
npm run build:workbenchd
npm run run:workbenchd -- --config /absolute/path/workbench.json
npm run test:contract:workbench
```

- `--help` and `--version` exit without starting a host.
- SIGINT/SIGTERM stops external intake, joins connections and ACP adapters, commits actor cancellation and joins actors. Persistence failures produce an unsuccessful exit.
- One host holds an exclusive storage lease. `storage-format.json` identifies format 2. Missing markers in nonempty directories, incompatible versions and corrupt markers fail closed.
- Back up old data and explicitly choose an empty storage directory. Startup does not migrate or delete old data, and does not unlink an existing socket path.
- Socket mode is `0600`; peer credentials must match the host UID. Cleanup only removes the socket inode originally bound by that listener.

## Owned ingress and cancellation

The host has bounded owned execution: 64 ordinary operation slots, 16 reserved control slots and 16 reserved query slots. Per-session mutating commands are FIFO; reserves do not let a control command overtake an earlier configuration for that same session. Other sessions and read-only queries remain independently executable. Disconnecting a caller drops its reply observer, not a started host task. Registry routing also avoids awaiting store I/O: at most 16 owned create/load/list/cold-inspect/remove jobs run concurrently; commands waiting behind loading/removing session lanes share a mailbox-sized bounded queue. Saturation returns backpressure without blocking live actor routing. Concurrent loads retain one owner and queued same-session commands stay FIFO.

Shutdown rejects queued unstarted requests, joins running work and protocol owners, and holds the storage lease until host cleanup finishes. Runtime retains and joins the Registry root; aborted-root recovery preserves accepted I/O and actor tasks rather than aborting their futures. Fatal Registry closure is propagated through host ingress. Physical protocol workers stop before fatal actor drain publishes terminal intentions; outstanding host receipts and Registry recovery are joined together where necessary. Unexpected ingress exit is also fatal to the host and triggers joined cleanup.

`inspect` can read committed cold history without creating an actor or worker or rewriting the snapshot. `inspect`/`list` results are sent only to their request observer, not broadcast as change events; otherwise subscribers that refresh on changes would create query-echo loops. Explicit `load` still publishes its snapshot notification. `load` explicitly creates the owner and commits any restart-interruption recovery, including its durable notice. `Cancelling` is a durable intermediate status: the old worker epoch is fenced before native cancellation, but terminal `TurnCancelled` publication and delivery intent follow physical worker join. Removal also stops/joins the worker before deleting its source history. Failure of the initial cancellation commit leaves the live turn untouched; failure of the final commit leaves a fenced `Cancelling` intent for an explicit new cancel operation after storage recovers, or completion on cold load. Original failed operation receipts remain immutable.

## Per-harness launch configuration

`workers` contains optional `pi`, `codex`, and `claude` launch specifications, each with its own `command`, `args`, and `env`. At least one must be configured. Missing/null disables that harness; there is **no fallback** to the Pi command. Disabled harness history can still be loaded/inspected, but create/prompt is rejected before changing session state. The earlier singleton `workers.command` scaffold format is rejected.

`examples/workbench.json` enables only Pi. Add explicit specs for your installed Codex/Claude ACP executables; the host does not install providers, guess wrapper commands, invoke a shell implicitly or expand environment expressions inside arguments. Prefer externally managed credentials; the configured Bot-token environment variable is removed for every launch, including explicit per-harness environment overrides.

All harnesses share one global capacity semaphore and monotonically increasing worker epochs. `sessions.max_workers` and `sessions.mailbox` are each bounded to 1–1024; `limits.pending_interactions` is bounded to 1–32 and enforced before exposing excess provider requests. Commands/arguments/environment reject invalid NUL/key input at startup. Normal worker stop closes stdin after flushed protocol replies and gives a bounded EOF exit window before TERM/KILL process-group escalation.

## Provider catalogue projection

Snapshot `config.model` / `config.mode` are desired user preferences. `catalogue.current_model` / `catalogue.current_mode` are optional last-observed provider values; notifications do not silently rewrite those preferences. Live setting changes first commit `configuration_intent` (requested preferences and a known restore baseline), then configure the provider, and only then atomically commit the desired preference and clear the intent. Failed/uncertain configuration stops the adapter and retains the intent. The next prompt's native load must restore and confirm the baseline before sending any prompt; failed recovery leaves the intent and fails that turn, without replacing the native session. While an intent remains, further setting changes return busy. A failed operation ID continues replaying its original failure even after reconciliation; it never reissues the original setting command. Omitted catalogue fields preserve the committed projection, live explicit empty lists clear their offering, and empty native-load replay does not erase an existing catalogue. Available commands retain their typed input hints.

The ACP adapter drains initialize/load/configuration notifications before dispatching a new prompt. Native-load replay text, user echoes and plans are not appended as the new turn. Every update retains a validated native session ID; another session's notification fails the worker rather than modifying the current actor. A failed adapter is joined/replaced before reuse.

## Typed tool metadata

Committed tool state/events contain `details` with optional kind/name, typed text/diff/resource text/link content, locations, and display-only terminal references. V1 patches preserve omitted/null fields, replace concrete lists and clear lists on `[]`; unknown kinds do not overwrite known kinds. Raw input/output are opaque protocol-only fields, never arbitrary JSON in business state. Tool paths/URIs are untrusted display data, not authority to open/fetch them; terminal capability remains disabled. Binary/unknown tool content has an explicit unsupported marker pending immutable media support. A host test exercises three synthetic worker profiles and cold restart, alongside an actual-binary IPC check: this establishes common ACP mapping, not live provider tool execution.

## Immutable agent image archive (incremental)

Agent `image` chunks now validate base64, canonical PNG/JPEG/GIF/WebP MIME, a MIME signature and a 4 MiB decoded-byte limit. These checks are **not complete image decoding or sanitization**. Image URIs are ignored, never opened/fetched. The SessionActor archives independent checksummed/versioned bytes before committing a reference. Public `AgentImage { session, turn, entry, message, image }` events and snapshot entry `image` fields contain only `{ id, mime, bytes, sha256 }`; base64 is never embedded in snapshots/events. Opaque `message` stream grouping metadata is preserved.

Payload identity is immutable and verified on read against the full expected reference; files survive source removal for pending delivery/history references. Archive failure publishes no reference; later history failure may leave a safe orphan, never a dangling committed reference. Stale turns are fenced before archive writes. Native fork does not accept an image-bearing target group based only on a text key.

This step covers storage/recovery and metadata publication. Telegram output additionally uploads verified archive bytes with typed multipart requests (PNG/JPEG photo, GIF animation, WebP document), preserving text/image order within each delivery and durable retry without ACP reexecution. Mock HTTP and actual-binary process tests cover 429/restart. A durable outbox admission sequence now orders cross-delivery parts within each resolved topic, including deferred retry heads and direct command notices; domain revisions are not a common delivery clock. At most eight retained, joined delivery jobs now send across distinct topic lanes concurrently; a held image HTTP response cannot stall other topics while capacity remains, and same-topic FIFO survives. Driver/supervisor abort and cancelled cleanup wait retain accepted ack ownership. Image prompt input and tool image assets remain incomplete. The explicit IPC archive read below now backs image display in the default new browser; full UI parity, old source deletion and release migration remain pending. Outbox bodies now require version 2 plus sequence and scoped `Session { session, cwd }` targets (outer envelope still format2); pre-sequence/body-version-1/old target layouts are explicitly rejected, not migrated. Frozen source workspace scope lets an existing authorized topic receive immutable archived output after external source deletion/restart. It does not authorize another topic or filesystem path: current binding/chat/workspace checks still apply, and a conflicting live scope fails closed. Missing source inspection does not perform a load or journal mutation. No live Bot acceptance is claimed.

## Live transcript identity and image reads

`UserPromptAdded` now includes its committed `entry` ID. `AgentText`, `AgentThought` and `AgentImage` include `entry` plus nullable `message`. Each delta identifies its own distinct committed snapshot row, even when several deltas share one opaque group. Clients may group display by `(session, turn, message)` but must not reinterpret it as a timestamp/native position or merge/rewrite immutable archive IDs. Entry metadata does not itself prove a safe native fork cut. These are new required entry fields in the in-progress protocol; older incompatible stored event receipts fail closed rather than being silently upgraded.

The same authenticated local-UID IPC connection can read a known immutable image reference:

```json
{
  "version": 2,
  "id": 9,
  "command": {
    "method": "image",
    "image": {
      "id": "IMAGE_ID",
      "mime": "image/png",
      "bytes": 68,
      "sha256": "FULL_64_CHARACTER_SHA256"
    }
  }
}
```

Use the complete validated `ImageRef` from an event/snapshot (the values above are placeholders), not a path, URI or remote file ID. The dedicated response is `{"type":"image","id":9,"asset":{"format_version":1,"image":IMAGE_REF,"data":"BASE64"}}` (abbreviated). Only this explicit read response contains bytes; snapshots and subscribed domain events remain metadata-only. The host verifies archive envelope/checksum, MIME/signature/decoded-size/hash and full expected reference; wrong identity or corruption returns an error with no pixels. This is not a full image decoder/sanitizer. A maximum 4 MiB asset fits the existing 8 MiB NDJSON frame and has a transport test.

Image reads use the connection's query pool (4), bounded host query ingress (16) and owned I/O tasks, with no session lane, actor/native load, command side effect or journal result. A top-level `operation` is rejected as `invalid_input`, not made durable. Requests do not provide filesystem authority: the fixed archive ID resolves only under this host's payload store. This is the existing trusted local OS-user API, not Telegram topic authorization or a remote access endpoint. References remain readable after source removal/restart. Provider/Bot credentials are neither required nor involved. The default new browser now uses this read through its trusted extension controller; image prompt input/tool binary assets and full decoding/sanitization are still pending.

## Native branching (incremental Pi path)

`fork` accepts a committed domain entry, not a provider path or client-supplied native hash:

```json
{
  "version": 2,
  "id": 7,
  "operation": "my-fork-once",
  "command": { "method": "fork", "session": "SOURCE_ID", "request": { "entry": "DOMAIN_ENTRY_ID" } }
}
```

The source must be idle, have saved native identity and no unresolved configuration intent. The peer must negotiate `_meta["pi-workbench"]` version 1 with both inspection and native-fork capabilities; another harness/name or unknown version does not grant those methods. Fresh native points are validated and the SessionActor alone constructs the immutable prefix projection. Repeated equal-text matches, unsafe points and partial assistant chunks fail closed rather than guessing a native position. Optional ACP `messageId` is a validated opaque stream-group ID (Pi currently generates UUIDs), **not a native entry ID or timestamp**. Snapshot transcript deltas preserve it as optional `message`; each delta retains its distinct immutable `id` and archive. An idle assistant target may be the final text row of a contiguous same-turn group: the complete concatenated text must uniquely match fresh safe native prefix evidence. Earlier rows, interleaved/reused IDs, a trailing thought, and missing group evidence on multi-chunk turns remain unsupported; IDs never select native cuts directly. Current turn-granularity tool metadata is retained only for provably earlier turns.

Success returns `SessionCreated` for a new workbench/native session, with `transcript.origin` identifying its parent/cut. The source transcript/preferences/native identity are not replaced. The idle source adapter is joined to free worker capacity. The branch's desired settings start unset: its first prompt native-loads historical branch-point settings, never applies the source's current model/mode or text-seeds its context. Inherited history does not enqueue a new delivery of every old entry.

Supply a stable operation ID. Replay returns the original receipt even after source deletion/restart. `native_fork_uncertain` means a remote branch may exist; the same operation never issues another fork. `native_fork_unadopted` preserves the confirmed native ID in its durable failed result/message when local adoption failed; a local history file may already exist after a post-write failure. Do not delete native files or blindly retry with new IDs to hide these outcomes. `unsupported_feature` is a negotiation/harness rejection. Native fork has a 180s response deadline and host shutdown stops/joins its protocol owner (attempting typed fork cancellation before forced cleanup).

To cancel a pending fork, use a separate durable command whose nested operation identifies the ORIGINAL fork:

```json
{
  "version": 2,
  "id": 8,
  "operation": "cancel-my-fork-once",
  "command": { "method": "cancel_fork", "session": "SOURCE_ID", "operation": "my-fork-once" }
}
```

It has independent control admission and never cancels another operation or an unrelated turn. A queued target can seal its `fork_cancelled` failure without waiting behind a slow source mutation; the cancel returns a `ForkCancelled` workflow receipt (not `TurnCancelled`). An active remote request is explicitly cancelled and its peer joined, but may still yield `native_fork_uncertain` because remote creation cannot be undone by pretending it never happened. If confirmed success wins the race, cancel returns the original `SessionCreated` receipt. No matching pending target returns `fork_not_running`. Cancel's durable Started precedes its signal; a failed admission write does not touch the peer. Replay never cancels a later prompt. Host shutdown also durably seals a cancelled queued target before releasing storage.

Separate Pi 1.3.0 offline acceptance now exercises the real CLI/native helper, bundled ACP adapter and new Rust WorkbenchApp, on synthetic local conversation files with zero model/network requests. It verifies images/tool pairs/labels/compaction in native prefixes, historical settings, a one-worker limit and durable replay after source removal/restart. Run it explicitly with `PI_OFFLINE_PI_CLI=/absolute/path/to/pi/dist/cli.js npm run test:native-fork:offline`; the default workspace marks its environment-dependent Rust case ignored, and this command actually runs it with `--ignored`. Captured sanitized native responses also have a mandatory typed DTO test. This is not live model/provider traffic or production-binary SDK acceptance. Complete contiguous grouped assistant text is now verified against real SDK native prefixes using explicitly synthetic display deltas, and against the synthetic live stdio peer across restart/immutable archives. Exact native identity for repeated equal-text messages, same-turn tool/media projection and fork/cancel UI remain incomplete. The VS Code client has not migrated to these commands yet.

## Framing

UTF-8 NDJSON, one request/message per line. Each frame is bounded at 8 MiB; malformed input closes only that connection. At most 64 connections and 32 session subscriptions per connection are admitted. Each connection additionally allows 16 ordinary commands, 4 control commands (cancel/answer/remove) and 4 query commands, with at most 24 concurrent reply observers. Session commands are synchronously admitted in wire order before their replies are awaited concurrently. Image reads are auxiliary read-only queries admitted when their observer is polled; they are not mutation ordering barriers. A blocked provider does not stop input, query/control reserves or subscription events on that stream. Excess admission returns `backpressure`. Duplicate in-flight correlation IDs close only that connection; reuse an ID only after its reply. Slow readers are disconnected. Broadcast lag sends `resync_required` and closes; clients must reconnect and inspect/reload their subscriptions instead of assuming a complete event stream.

```json
{"version":2,"id":1,"operation":"create-unique-client-operation","command":{"method":"create","harness":"Pi","cwd":"/absolute/workspace"}}
{"version":2,"id":2,"command":{"method":"subscribe","session":"SESSION_ID"}}
{"version":2,"id":3,"command":{"method":"prompt","session":"SESSION_ID","prompt":"你好"}}
```

Other commands: `load`, `list`, `inspect`, `image`, `cancel`, `answer`, `fork`, `cancel_fork`, `set_model`, `set_mode`, `remove`, `unsubscribe`. Exact typed fields are defined in `rust/crates/pi-acp-workbenchd/src/transport/vscode.rs`. Domain state/event payloads are defined under `src/domain/` and currently use Serde's externally tagged enum representation. Replies may be out of order; queries read committed state and are not a barrier for an earlier mutation. Mutations retain per-session admission FIFO. Disconnecting drops reply observers, not accepted host execution. Request `id` correlates a connection's replies; optional top-level `operation` is a stable validated string used for durable idempotency across connections and process restarts. All mutating host commands write a durable Started journal entry before their effects (the host generates an operation ID when one is not supplied). For reconnect/retry, clients must supply and retain their own operation ID. A completed operation returns its original receipt without republishing events or rerunning the command. Reusing the ID with different command fields returns `operation_conflict`; uncertain Started operations return `operation_interrupted` and are never automatically executed again. Expired results retain tombstones and return `operation_expired`. Missing/corrupt receipts/results fail closed.

```json
{"type":"reply","id":1,"events":[{"SessionCreated":{"id":"..."}}]}
{"type":"event","event":{"AgentText":{"session":"...","turn":"...","entry":"...","message":"opaque-stream-group","text":"hello"}}}
{"type":"error","id":3,"code":"busy","message":"session is busy"}
{"type":"resync_required"}
```

The abbreviated `SessionCreated` above omits snapshot fields for readability. A reply means the command's domain transition has committed; a prompt reply is not turn completion. Subscribe first and wait for `TurnFinished`/`SessionError` for completion, or inspect after reconnecting. Events may also arrive on the initiating connection, so clients must project them idempotently rather than duplicating their reply projection.

Internal `Agent`, worker-epoch and supervisor messages are not part of `ClientCommand` and cannot be injected through this adapter. Transport tests cover this boundary, isolation of malformed connections, socket permissions/ownership-safe cleanup, shared-runtime text streaming and host shutdown. The process contract additionally covers persistence, native-session restoration, duplicate-host exclusion, original-receipt replay across restart without repeated create/prompt effects, old-format rejection, same-stream blocked-provider isolation, bounded saturation with query/answer reserves, FIFO durable setting receipts and native fork/remove-source/restart/replay and operation-scoped same-stream fork cancellation. Additional checks compare live entry/group metadata against committed snapshots and retrieve exact image archive bytes before/after source deletion/restart, reject operation IDs/hash mismatch and prove image queries do not modify journal records or result files.
