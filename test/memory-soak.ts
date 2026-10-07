// Executed separately with --expose-gc; not part of the routine Vitest suite.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestJournal, requestFingerprint } from '../src/request-journal';
import { SharedHistoryStore } from '../src/shared-history';
import { SessionService } from '../src/session-service';
import { SessionServer, SessionClient } from '../src/session-wire';
import { TelegramStream } from '../src/telegram-stream';
const root = await mkdtemp(join(tmpdir(), 'pi-memory-'));
let service: SessionService | undefined, server: SessionServer | undefined;
async function heap() {
  for (let i = 0; i < 3; i++) {
    global.gc!();
    await delay(10);
  }
  return process.memoryUsage().heapUsed / 1024 / 1024;
}
try {
  assert(global.gc, 'Run using --expose-gc');
  const store = new SharedHistoryStore(join(root, 'history'));
  await store.claim('one');
  await store.write({
    id: 'one',
    harness: 'pi',
    cwd: root,
    title: 'Memory audit',
    updated: Date.now(),
    contextComplete: true,
    entries: [{ id: 'old', role: 'user', text: 'history'.repeat(10000) }],
  });
  await store.releaseAll();
  const journal = new RequestJournal(join(root, 'service', 'requests'));
  await journal.initialize(async () => {});
  const params = { sessionId: 'one', prompt: [{ type: 'text', text: 'deduplicated' }] };
  // 64 MiB of durable receipts: none should remain resident after startup or lookup.
  for (let i = 0; i < 1024; i++)
    await journal.write({
      id: 'receipt-' + i,
      sessionId: 'one',
      fingerprint: requestFingerprint('prompt', params),
      status: 'completed',
      result: { stopReason: 'end_turn', padding: String(i).padEnd(65536, 'x') },
    });
  const baseline = await heap();
  service = new SessionService(
    root,
    { command: 'must-never-spawn', args: [], maxWorkers: 1, idleMs: 1000 },
    () => {},
    () => {},
  );
  await service.initialize();
  const startup = await heap();
  const socket = join(root, 'service', 'memory.sock');
  server = new SessionServer(socket, (m, p, id) => service!.handle(m, p, id));
  await server.listen();
  const batches: number[] = [];
  for (let batch = 0; batch < 6; batch++) {
    for (let i = 0; i < 200; i++)
      await service.handle('prompt', params, 'receipt-' + ((batch * 200 + i) % 1024));
    for (let i = 0; i < 25; i++) {
      const client = new SessionClient(socket);
      try {
        await client.call('state', { sessionId: 'one' });
        await client.call('cancel', { sessionId: 'one' });
      } finally {
        client.dispose();
      }
    }
    await delay(30);
    batches.push(await heap());
    assert.equal((service as any).journal.pendingCount, 0);
    assert.equal((service as any).queue.pendingCount, 0);
    assert.equal((service as any).store.seen.size, 0);
    assert.equal((server as any).sockets.size, 0);
    assert.equal((server as any).pending, 0);
    assert.equal((server as any).outgoingBytes, 0);
    assert.equal((server as any).outgoing.size, 0);
  }
  const previews = Array.from({ length: 32 }, (_, i) => {
    const stream = new TelegramStream(
      { call: async <T>() => ({}) as T, dispose() {} },
      1,
      1,
      1000000,
    );
    stream.update(String(i) + 'x'.repeat(4 * 1024 * 1024));
    return stream;
  });
  let previewsHeap: number;
  try {
    previewsHeap = await heap();
    assert(
      previewsHeap - batches.at(-1)! < 8,
      'Small previews retained their large source strings',
    );
  } finally {
    for (const preview of previews) preview.dispose();
  }
  assert(startup - baseline < 12, 'Receipt startup retained too much memory');
  assert(Math.max(...batches) - baseline < 16, 'Repeated operations retained too much memory');
  assert(batches.at(-1)! - batches[1] < 8, 'Heap kept growing across batches');
  console.log(
    JSON.stringify({
      receiptFiles: 1024,
      receiptMiB: 64,
      repeatedRequests: 1200,
      connectionCycles: 150,
      previewSourcesMiB: 128,
      heapMiB: {
        baseline: +baseline.toFixed(2),
        startup: +startup.toFixed(2),
        batches: batches.map((n) => +n.toFixed(2)),
        withPreviews: +previewsHeap!.toFixed(2),
      },
      resourcesReleased: true,
    }),
  );
} finally {
  await server?.dispose();
  await service?.dispose();
  await rm(root, { recursive: true, force: true });
}
