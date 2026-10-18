# Single-host Linux artifact

This guide describes the current source-built artifact, not historical published releases. No repository script installs, enables or restarts a real service. Perform deployment only with operator authorization and a separate backup/recovery policy. Local artifact verification is not proof of live provider/Bot compatibility.

## Build and verify locally

In the source checkout, with Node 22+, Cargo/Rust and Linux x86_64 tooling:

```sh
npm ci
npm run build
npm run test:rewrite
```

The unified gate builds the production Rust workspace with `--release --locked`, packages it, and runs the actual `pi-acp-workbenchd` with an isolated synthetic ACP peer. The directory manifest includes target/ELF ABI, binary SHA-256, Rust source hash, git provenance and production/features metadata. A dirty worktree is explicitly recorded, not represented as a clean commit.

Default output:

- `service-dist/pi-acp-workbenchd`, `manifest.json` (one control binary).
- `service-artifacts/pi-acp-services-VERSION-TARGET.tar.gz` and `.sha256`.
- Archive content: binary/manifest, `SHA256SUMS`, licenses/notices, current IPC/Telegram/VS Code/storage guides, and only `examples/pi-acp-workbenchd.service` + `examples/workbench.json`.

`build:services` supports GNU and musl x86_64 target flags. Building or testing the GNU artifact locally does **not** establish musl/cross-target acceptance; verify each actual target separately. Provider workers remain separately installed external executables. Rustls uses bundled roots; Node is needed for Node-based provider adapters, not for native maintenance itself.

## Inspect an archive before manual installation

Verify the `.sha256` file against an independently trusted release digest, list the archive, then extract into a new private staging directory. Do not extract over configuration, credentials or data. Inside the extracted directory:

```sh
sha256sum -c SHA256SUMS
./pi-acp-workbenchd --version
./pi-acp-workbenchd --help
```

Checksums detect corruption, not publisher authenticity. Source provenance and local package hashes are recorded in the verification ledger; independently verify the release source/signer for an externally obtained archive.

## Configure the only control process

Edit `examples/workbench.json`: substitute the absolute storage root and explicit per-provider worker executable/args/env. Use a separate empty root on first start; do not point a new incompatible build at historical live storage. A disabled provider is `null`, never a silent fallback.

For Telegram, add the merged optional Telegram section as described in [Telegram](workbench-telegram.md): canonical workspace, allowed chat/user IDs, and the **name** of the token environment variable. Token bytes never belong in JSON, archive, CLI arguments or repository. Provider/Bot credentials are operator-managed and are not included in an artifact.

The single unit example has an absolute `ExecStart` placeholder. Configure it to this artifact and a private operator-owned config file before manually installing/enabling it. The service account needs access to its workspace/storage and configured provider executable, not root privileges. There is no second Telegram unit, relay, internal session socket or interactive setup tool.

For a manual foreground check after configuration:

```sh
./pi-acp-workbenchd --config /absolute/path/workbench.json
```

VS Code must use the matching current-source VSIX and [IPC v2](workbench-ipc.md) socket `<storage.root>/workbench.sock`. The extension does not start the daemon. See [VS Code](workbench-vscode.md) for trust/canonical-workspace checks and UI limits.

## Stop, inspect and back up before replacement

Normal shutdown stops admission, joins provider/adapter/file transactions and retains the storage lease until physical cleanup. Killing a process may leave uncertain remote effects; never infer rollback from a lost socket or replay tools using a fresh operation ID.

Maintenance is built into the **same binary**:

```sh
./pi-acp-workbenchd storage export --root /canonical/absolute/data \
  --destination /absolute/existing-parent/new-backup --confirm
```

It must obtain the host flock and refuses a leftover socket until independently inspected. Never delete `.workbench.lock` to bypass a lease. Export does not migrate formats; reset accepts only marker-only roots. Current GC compacts only typed Telegram inbox/callback state, not archives, history, journal or outbox high-water/tombstones. Read [storage maintenance](workbench-storage.md) before any mutation.

Upgrade/downgrade requires matching binary/client/storage formats. Incompatible, corrupt or unversioned nonempty roots fail closed; there is no automatic migration or rollback reader. Retain old artifacts and independently validated backups, and use an isolated root to evaluate a replacement. This documentation does not authorize touching real services or user data.
