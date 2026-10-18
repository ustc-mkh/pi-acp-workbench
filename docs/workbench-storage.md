# Explicit offline storage maintenance

The **same `pi-acp-workbenchd` binary** provides maintenance subcommands. They do not start the runtime, provider workers, IPC listener or Telegram/network client, and do not read account configuration. All require `--confirm`, a canonical absolute non-root directory, an existing exact format-2 marker and the **same exclusive `flock` lease** as the host. A persistent `.workbench.lock` is normal: **never remove it to bypass a lock**. A live host is excluded even before its socket exists. An unlocked persistent lock file does not prevent maintenance.

Maintenance refuses any socket, symlink (including dangling links), FIFO or other special file in the source tree. A leftover `workbench.sock` after process loss requires independent operator inspection; it is not silently deleted. These checks protect against accidental path traversal, not a hostile process running as the same Unix account and rewriting directories concurrently. Stop the service, prevent automatic restarts and restrict access before maintenance.

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

GC validates the checksummed, versioned Telegram state through the existing **typed store** and atomically compacts it under the storage lease:

- Completed inbox records may be removed. The durable update offset remains unchanged, so an old update cannot execute again after restart.
- Expired callbacks may be removed **only if no pending inbox record references them**.
- Unexpired consumed callbacks remain to reject repeated clicks. Pending answers retain their exact consumed callback receipt even after expiry.
- The state is written atomically, with its checksum updated; failed writes do not publish a partial state. Repeated GC is idempotent.

Callbacks with no expiry (`u64::MAX`) are deliberately retained even if consumed. Therefore this GC does **not** eliminate the 4096-binding cap for indefinitely retained interactions. Reclaiming those keys safely requires additional typed session/interaction/outbox liveness evidence; it is still an open retention-policy task, not permission to reset offsets or discard receipts.

The JSON summary reports `removed_inbox` and `removed_callbacks`. Missing Telegram state is a no-op; corrupt/unknown state fails closed without rewrite.

**Archive/journal/outbox GC is not implemented.** The earlier JavaScript filename/string-reference scan has been removed: direct-string searches miss transitive archive and durable result references and cannot establish safe reachability. Image orphans, entry/interaction/notice archives, journal results/receipts, history projection ledgers, outbox acknowledgement tombstones and admission sequence high-water are all retained. No age threshold or filename guess authorizes their deletion. A future implementation requires a validated typed root graph plus crash-safe high-water/dedup retention.

## Reset: marker-only roots

```sh
./pi-acp-workbenchd storage reset --root /absolute/canonical/marker-only-data --confirm
```

Reset refuses any contents besides `storage-format.json` and the persistent `.workbench.lock`. It removes only the format marker, **retaining the directory and stable lock inode**. Removing/replacing that inode while another process has opened it could create two independent leases; reset must never do that. A later normal host start can initialize the now marker-only root safely. A data-bearing or unversioned directory is never reset or migrated.

All tests use isolated temporary roots. Coverage includes cross-process host-compatible lock exclusion, unlocked persistent locks, byte/hash export, canonical overlap, symlink refusal, marker-only reset, corrupted Telegram state, pending callback protection, offset/restart deduplication and compaction failure preservation. This is not live-provider/Bot acceptance, full image decoding or a complete storage retention policy.
