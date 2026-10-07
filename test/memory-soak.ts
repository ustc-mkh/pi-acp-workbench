// External Rust RSS/FD soak: no retired TS service internals and no real worker.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { SharedHistoryStore } from '../src/shared-history';
import { SessionClient } from '../src/session-wire';
import { startRustService } from './rust-service';
import { processResources, requestFingerprint } from './rust-utils';
const root = await mkdtemp(join(tmpdir(), 'pi-rust-memory-'));
let service: Awaited<ReturnType<typeof startRustService>> | undefined;
try {
  const store = new SharedHistoryStore(join(root, 'history'));
  await store.claim('one');
  try {
    await store.write({
      id: 'one',
      harness: 'pi',
      cwd: root,
      title: 'Memory audit',
      updated: Date.now(),
      contextComplete: true,
      entries: [{ id: 'old', role: 'user', text: 'history'.repeat(10000) }],
    });
  } finally {
    await store.releaseAll();
  }
  const requests = join(root, 'service', 'requests');
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const params = { sessionId: 'one', prompt: [{ type: 'text', text: 'deduplicated' }] };
  for (let i = 0; i < 1024; i++) {
    const id = 'receipt-' + i,
      file = join(requests, createHash('sha256').update(id).digest('hex') + '.json');
    await writeFile(
      file,
      JSON.stringify({
        id,
        sessionId: 'one',
        fingerprint: requestFingerprint('prompt', params),
        status: 'completed',
        result: { stopReason: 'end_turn', padding: String(i).padEnd(65536, 'x') },
      }),
      { mode: 0o600 },
    );
  }
  service = await startRustService(root, {
    command: 'must-never-spawn',
    args: [],
    maxWorkers: 1,
    idleMs: 1000,
  });
  await delay(250);
  const baseline = await processResources(service.child.pid!);
  assert.equal(baseline.workers.length, 0);
  const client = new SessionClient(service.socket),
    batches: Awaited<ReturnType<typeof processResources>>[] = [];
  try {
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 200; i++)
        await client.call('prompt', params, 'receipt-' + ((batch * 200 + i) % 1024));
      for (let i = 0; i < 25; i++) {
        const probe = new SessionClient(service.socket);
        try {
          await probe.call('state', { sessionId: 'one' });
          await probe.call('cancel', { sessionId: 'one' });
        } finally {
          probe.dispose();
        }
      }
      await delay(50);
      const resources = await processResources(service.child.pid!);
      batches.push(resources);
      assert.equal(
        resources.workers.length,
        0,
        'Cached receipts or read-only state spawned a worker',
      );
      assert(
        resources.fdCount <= baseline.fdCount + 3,
        'Socket/file descriptors grew across cycles',
      );
      assert(resources.rssMiB - baseline.rssMiB < 24, 'Receipt lookup retained too much memory');
    }
  } finally {
    client.dispose();
  }
  await delay(100);
  const released = await processResources(service.child.pid!);
  assert(released.fdCount <= baseline.fdCount, 'Client descriptors were not released');
  assert(batches.at(-1)!.rssMiB - batches[1].rssMiB < 8, 'Rust RSS kept growing across batches');
  console.log(
    JSON.stringify({
      implementation: 'rust',
      receiptFiles: 1024,
      receiptMiB: 64,
      repeatedRequests: 1200,
      connectionCycles: 150,
      baseline,
      batches,
      released,
      resourcesReleased: true,
    }),
  );
} finally {
  await service?.stop();
  await rm(root, { recursive: true, force: true });
}
