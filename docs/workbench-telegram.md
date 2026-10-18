# Single-host Telegram adapter

The new adapter runs **inside `pi-acp-workbenchd`**. Polling, admission, command execution, rendering and delivery share the same `WorkbenchApp` as external IPC; they do not use the legacy session socket or Telegram daemon.

This describes the currently implemented path, not final rewrite acceptance. The VS Code extension and production release scripts still need cutover. Provider extensions, native fork UI, image prompt input/tool assets and the remaining rich Telegram UI/history features are not complete. Archived agent image output can now be uploaded as described below.

## Configuration

Set `telegram` in the merged configuration. The token is read from the named environment variable and is never stored in JSON:

```json
{
  "bot_token_env": "WORKBENCH_BOT_TOKEN",
  "workspace": "/absolute/allowed/workspace-root",
  "allowed_chat_ids": [-1001234567890],
  "allowed_user_ids": [123456789],
  "inbox_capacity": 128
}
```

- `workspace` must exist. New/attached sessions and operations are restricted to its canonical subtree; symlink escapes are rejected.
- `allowed_chat_ids` must be nonempty. An empty `allowed_user_ids` authorizes all non-bot participants of those chats; use explicit user IDs when that is not intended.
- Bot-origin messages are ignored. Callback identity is never inferred from sender ID or an inline message without an actual chat/topic.
- Default `api_base` is `https://api.telegram.org/`. Plain HTTP is accepted only for an explicitly configured loopback fixture endpoint. Redirects are disabled.
- Bot credentials are removed from ACP child environments, including explicit worker environment overrides using the same variable name. API errors do not retain request URLs or remote descriptions.
- Use a fresh storage root or explicitly handle old data offline. Startup does not migrate/delete old data or drop Telegram's pending updates.

## Commands and interactions

| Input                                       | Behavior                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/new [pi\|codex\|claude] [absolute-path]`  | New session under the allowed root. In forum General, create and bind a new topic; in an existing topic, bind the new session there. |
| `/attach SESSION_ID`                        | Bind an authorized existing session to this topic. Currently one Telegram topic per session.                                         |
| `/sessions`                                 | List sessions under the allowed root.                                                                                                |
| `/status`                                   | Show session state, settings and **Plan/Todo**. No live Todo notifications.                                                          |
| `/cancel`, `/remove`                        | Cancel the bound turn or remove the bound session.                                                                                   |
| `/model ID`, `/mode ID`                     | Apply a provider-offered setting.                                                                                                    |
| `/answer INTERACTION_ID TEXT_OR_TYPED_JSON` | Answer a specific interaction without retargeting a newer request.                                                                   |
| `/prompt TEXT`, `//TEXT`                    | Explicit prompt rather than a guessed answer.                                                                                        |
| `/help`                                     | Current command help.                                                                                                                |

Ordinary text is classified at admission. With exactly one pending interaction it becomes a validated answer to that interaction; with several it is rejected as ambiguous. A rejected/expired/duplicate answer never becomes a prompt during later execution. Supported permission and single-choice/boolean fields have durable, topic-bound buttons. Multi-field and multi-select answers can use the typed form representation, for example:

```text
/answer INTERACTION_ID {"Form":{"fields":{"name":{"Text":"Ada"},"count":{"Integer":2},"choices":{"Selected":["a","b"]}}}}
```

Only supplied fields supported by the actual definition are accepted. Unknown fields, wrong choices/types, expiry and missing required values are rejected. Decline/cancel buttons are explicit typed responses.

## Archived image output

Agent image bytes are immutable, independently checksummed payloads; snapshots and public events contain only references. Delivery verifies the expected reference and uploads local bytes with multipart forms: PNG/JPEG via `sendPhoto`, GIF via `sendAnimation`, WebP via `sendDocument`. Filename and MIME derive only from validated archive metadata. Image URIs are never opened/fetched; there is no remote URL or file-id fallback. Decoded input is capped at 4 MiB. Encoding/MIME signature checks are not complete image decoding/sanitization, and local mock acceptance does not prove live Bot media acceptance.

Within a completed turn, archived text/image order is preserved. Text deltas in the same opaque group concatenate; distinct known groups get a paragraph boundary. Standalone image outbox IDs also resolve through the immutable archive. Image uploads share bounded response parsing, redirect refusal and token/description-redacted errors with text requests. A persisted 429 resumes after restart without starting ACP. Partial multi-part success or an uncertain/crash-after-send outcome may duplicate already sent parts on retry: delivery remains **at least once**, not exactly once.

This does not implement incoming photo prompts, tool binary assets or browser media display. The separate trusted local IPC now has an explicit verified `image` archive query; see `docs/workbench-ipc.md`. Bounded parallel cross-topic sending and the durable per-topic retry barrier are described below. Retained archive bytes alone do not grant new topic/workspace authorization. A scoped session delivery can survive external source deletion only while its existing topic binding and current configured workspace authorization remain valid.

## Durability and lifecycle

1. Offset, classified inbox command and callback consumption commit together in a checksummed version-2 record.
2. Host commands use the inbox's stable operation ID. Restart replays the original receipt rather than creating another session or running another prompt.
3. `createForumTopic` has its own durable Started/result receipt. An uncertain transport/server outcome is **not retried**: the host cannot know whether Telegram already created the topic. Inspect/reconcile that operation before issuing a new request.
4. Immutable control notices and agent entry/interaction references enter the durable outbox before inbox completion. Retry/429 metadata survives restart and never invokes an agent.
5. Delivery is at least once: a crash after Telegram accepts a message but before durable ack can duplicate that message. Ack tombstones suppress later projection/re-enqueue. Acknowledgement failure never means the intent is discarded.
6. Execution has bounded 8 ordinary / 4 control / 4 query slots. Topic mutations stay FIFO, including pending mutations ahead of later controls. `/status`, `/sessions`, `/help` and rejection notices may read committed state independently of a blocked topic. A busy provider cannot occupy every execution class. Admission/status inspect cold snapshots without starting actors; scoped mutation execution explicitly loads its actor before issuing the frozen command.
7. SIGINT/SIGTERM and fatal polling/listener/task failures close host admission and start physical worker cleanup before joining adapter execution, avoiding a provider-wait/shutdown cycle. Accepted host operations settle; records interrupted at shutdown remain durably classified Pending and recover their original receipts after restart. The host releases storage only after transport and runtime joins. Polling/delivery cancellation interrupts HTTP waits, not admitted inbox/callback/archive/ack file writes. An uncertain send remains Pending and may duplicate on retry, as described above. Normal cancellation waits for flushed ACP cancel/interaction responses before worker stop; unresponsive peers have a bounded forced-stop fallback. Obsolete worker events are fenced.

8. Outbox records now have body `format_version: 2` and a positive, unique durable `sequence`. This is **outbox admission order**, not a common clock of domain revisions or provider timestamps. A session revision and a Telegram update revision are not comparable. Ack tombstones retain the sequence high-water mark across restart; any future tombstone GC must preserve it first. Zero/duplicate/exhausted sequences, pre-sequence records and previous body-version-1 records fail closed, without rewriting/migrating them. The outer storage envelope remains format2; use fresh storage rather than expecting old outbox bodies to load.
9. Delivery scans all bounded pending capacity (currently 1024), including records whose retry time has not arrived. A deferred or newly failed head blocks subsequent records resolving to the same topic, including direct command notices behind session images. Other topics can progress past that backoff even after more than 64 queued records. Authorization still precedes rendering. A shared, retained JoinSet owns at most eight delivery jobs, with at most one active job per resolved topic. A slow HTTP request occupies only its lane; other topics can send while capacity remains. Eight occupied lanes apply bounded global backpressure rather than spawning more requests. Binding changes cannot move a scheduled job into another active lane; both old/current active destinations remain reserved until physical completion. Partial multi-part retry remains at least once.
10. Driver drop/abort cancels only its HTTP child token. The shared delivery JoinSet survives and is physically drained by supervision/adapter wait. Polling/execution/delivery sibling handles are also retained outside the supervisor future, so supervisor abort does not abort accepted file transactions. A cancelled cleanup wait can be resumed; the terminal error remains stored until all children/delivery jobs join. A paused-ack regression holds the storage lease through supervisor abort and cancellation of the first wait, then releases it only after ack/join and runtime shutdown. Other tests cover blocked image/other-topic progress, eight/ninth capacity, record-job panic and driver abort. These are local failure regressions, not long soak or a SIGKILL-host guarantee.

11. `DeliveryTarget::Session { session, cwd }` freezes the source workspace with each immutable intent. History validates target scope against its owning session even if the record checksum matches, and rejects workspace changes across revisions. Sender revalidates the frozen cwd against the current configured canonical workspace and resolves the existing authorized topic binding; it does not infer authorization from retained bytes. A missing source snapshot no longer drops an otherwise authorized archived text/image intent. A live snapshot with a different scope is a fatal identity mismatch; denied/unbound destinations do not read/upload image payloads. `/remove` still unbinds the topic; external IPC removal can leave the prior binding for already accepted deliveries. Old target/body layouts are explicitly rejected, not migrated.
12. Cold `inspect` reads return None for missing/deleted sessions; delivery does not turn that absence into `load`, actor creation or a journaled mutation. Regression coverage removes an image-producing source, restarts, sends its original archive bytes to its prior authorized topic and proves no new ACP trace/journal writes. A local actual-binary case combines source deletion, fatal media cancellation, restart and matching-byte delivery with no ACP calls.

## Local verification

```sh
cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd
npm run test:contract:workbench
npm run test:contract:workbench:telegram
```

The last command launches the actual new binary, a local HTTP mock Bot and the independent synthetic ACP peer. Its 15 checks test forum creation, shared IPC events, permission callbacks, wrong-topic/user rejection, persisted text and multipart image 429/restart retry with byte/topic/order verification and no overtaking by later same-topic control notices, bound-topic native resume without an explicit IPC load, child credential isolation, `/status`-only Todo, cross-topic/status progress during a blocked setting, flushed cancellation, other-topic output during a genuinely held image HTTP response, and fatal polling cleanup with both a blocked provider operation and held media HTTP. The cancelled HTTP socket closes and the archived image intent stays Pending; source deletion/restart then verifies frozen scope, original bytes/topic and no ACP rerun. A runtime regression additionally fills all eight ordinary topic lanes, checks query/answer reserves and FIFO, and verifies pending inbox recovery after shutdown. It does not use a real Bot token or establish real-provider compatibility. See `docs/rewrite-verification.md` for remaining acceptance gaps.
