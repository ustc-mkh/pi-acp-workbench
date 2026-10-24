# Single-host Linux artifact

This guide describes the current source-built artifact, not historical published releases. No repository script installs, enables or restarts a real service. Perform deployment only with operator authorization and a separate backup/recovery policy. Local artifact verification is not proof of live provider/Bot compatibility. See the [P6 validation record and outstanding blockers](workbench-p6-validation.md) for the current evidence boundary.

## Build and verify locally

In the source checkout, with Node 22+, Cargo/Rust and Linux x86_64 tooling:

```sh
npm ci
npm run build
npm run test:rewrite
```

The unified gate builds the production Rust workspace with `--release --locked`, packages it, and runs the actual `pi-acp-workbenchd` with an isolated synthetic ACP peer. The directory manifest includes target/ELF ABI, binary SHA-256, Rust source hash, git provenance and production/features metadata. A dirty worktree is explicitly recorded, not represented as a clean commit.

P6 diagnostics are separate from that gate:

```sh
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:mixed
npm run test:workbench:diff-benchmark
npm run test:workbench:host-mixed -- --binary "$PWD/service-dist/pi-acp-workbenchd" --dataset full
npm run test:workbench:soak -- --duration-seconds 600
# Requires an explicitly available graphical test environment.
npm run test:extension-host:full
```

The full dataset uses a stopped, test-owned temporary root for 10k sessions and 100k history entries, then runs actual IPC, a 4 MiB PNG, eight local mock HTTP lanes, 2048 deferred topics and concurrent headless Chromium display work. It never writes fixtures into a running or real root. Per-request timings include capture/physical stop where labelled; they do not provide internal durable-fence spans or live provider certification. The default five runs and raw distributions are retained under `.test-results/`; an interrupted/failed run stays failed. Use `--backlog-seconds 7200` with short samples to retain the two-hour delivery backlog rather than shrinking it with sampling time. The two-hour same-PID run is separately selected with `--runs 1 --duration-seconds 7200`; `--dataset small` retains the smaller IPC diagnostic workload and must be reported as such. Graphical Extension Host, authorized online providers/Bot and each production target still require their own evidence. For installed VSIX acceptance, package the client first and run `WORKBENCH_TEST_BINARY=/absolute/path/to/pi-acp-workbenchd node scripts/workbench-extension-host.mjs --full --vsix /absolute/path/to/candidate.vsix` in the isolated graphical test environment.

Default output:

- `service-dist/pi-acp-workbenchd`, `manifest.json` (one control binary).
- `service-artifacts/pi-acp-services-VERSION-TARGET.tar.gz` and `.sha256`.
- Archive content: binary/manifest (including matching IPC/storage/root policy contracts), `SHA256SUMS`, licenses/notices, the fixed public documentation allowlist including current usage/contracts, the next rewrite plan and cutover checklist (with package-local links checked), and only `examples/pi-acp-workbenchd.service` + `examples/workbench.json`.

`build:services` supports GNU and musl x86_64 target flags. Building or testing the GNU artifact locally does **not** establish musl/cross-target acceptance; verify each actual target separately. Provider workers remain separately installed external executables. Rustls uses bundled roots; Node is needed for Node-based provider adapters, not for native maintenance itself.

## Inspect an archive before manual installation

Verify the `.sha256` file against an independently trusted release digest, list the archive, then extract into a new private staging directory. Do not extract over configuration, credentials or data. Inside the extracted directory:

```sh
sha256sum -c SHA256SUMS
./pi-acp-workbenchd --version
./pi-acp-workbenchd --help
```

Checksums detect corruption, not publisher authenticity. Verify source provenance against the artifact manifest and independently verify the release source/signer for an externally obtained archive; a local package hash alone is not publisher authentication.

## Configure the only control process

Edit `examples/workbench.json`: substitute the absolute storage root and explicit per-provider worker executable/args/env. Use a separate empty root on first start; do not point a new incompatible build at historical live storage. A disabled provider is `null`, never a silent fallback.

For Telegram, add the merged optional Telegram section as described in [Telegram](workbench-telegram.md): canonical workspace, allowed chat/user IDs, and the **name** of the token environment variable. Token bytes never belong in JSON, archive, CLI arguments or repository. Provider/Bot credentials are operator-managed and are not included in an artifact.

The single unit example has an absolute `ExecStart` placeholder. Configure it to this artifact and a private operator-owned config file before manually installing/enabling it. The service account needs access to its workspace/storage and configured provider executable, not root privileges. There is no second Telegram unit, relay or internal session socket. The desktop Telegram setup wizard only creates a new config with explicit user/chat allowlists; it does not collect token bytes or install/start a service.

For a manual foreground check after configuration:

```sh
./pi-acp-workbenchd --config /absolute/path/workbench.json
```

VS Code must use the matching current-source VSIX and [IPC v3](workbench-ipc.md) socket `<storage.root>/workbench.sock`. The extension does not start the daemon. See [VS Code](workbench-vscode.md) for trust/canonical-workspace checks and UI limits.

Before any authorized switch, follow the [release/cutover checklist](workbench-cutover.md), including unresolved parity/live/SLO blockers and whole-combination rollback. Passing local artifact smoke does not approve deployment.

## Stop, inspect and back up before replacement

Normal shutdown stops admission, joins provider/adapter/file transactions and retains the storage lease until physical cleanup. Killing a process may leave uncertain remote effects; never infer rollback from a lost socket or replay tools using a fresh operation ID.

Maintenance is built into the **same binary**:

```sh
./pi-acp-workbenchd storage export --root /canonical/absolute/data \
  --destination /absolute/existing-parent/new-backup --confirm
```

It must obtain the host flock and refuses a leftover socket until independently inspected. Never delete `.workbench.lock` to bypass a lease. Export does not migrate formats; reset accepts only marker-only roots. Confirmed GC performs typed Telegram compaction and removes at most 500 unreferenced content rows per pass; `gc --dry-run` reports orphan candidates without mutation. It deliberately retains entries, receipts, delivery identities and high-water marks. Read [storage maintenance](workbench-storage.md) before any mutation.

Upgrade/downgrade requires matching binary/client/storage formats. Incompatible, corrupt or unversioned nonempty roots fail closed; there is no automatic migration or rollback reader. Retain old artifacts and independently validated backups, and use an isolated root to evaluate a replacement. This documentation does not authorize touching real services or user data.
