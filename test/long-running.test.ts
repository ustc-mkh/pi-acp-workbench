import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionClient } from '../src/session-wire';
import { SharedHistoryStore } from './support/history-fixture';
import { startRustService } from './rust-service';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
// Slow outbox/coalescing and Telegram queue/preview bounds now have Rust unit coverage.
it('reads and broadcasts >16 MiB Unicode history from the real Rust service only to subscribers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rust-history-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const text = '中文😀'.repeat(1800000),
    store = new SharedHistoryStore(join(root, 'history'));
  await store.claim('large');
  try {
    await store.write({
      id: 'large',
      harness: 'pi',
      cwd: root,
      title: 'Unicode',
      updated: Date.now(),
      contextComplete: true,
      entries: [{ id: 'answer', role: 'assistant', text }],
    });
  } finally {
    await store.releaseAll();
  }
  const service = await startRustService(root, {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 1,
    idleMs: 900000,
  });
  cleanup.push(() => service.stop());
  const events = vi.fn(),
    otherEvents = vi.fn(),
    lost = vi.fn();
  const client = new SessionClient(service.socket, events, lost),
    other = new SessionClient(service.socket, otherEvents, lost);
  cleanup.push(() => client.dispose());
  cleanup.push(() => other.dispose());
  await client.watch('large');
  await other.watch('other');
  expect((await client.call('state', { sessionId: 'large' })).snapshot.entries[0].text).toBe(text);
  const change = (modeId: string) =>
    client.call(
      'request',
      { sessionId: 'large', method: 'session/set_mode', params: { modeId } },
      undefined,
      0,
    );
  await change('high');
  expect(events.mock.calls.some(([event]) => event.snapshot?.entries[0]?.text === text)).toBe(true);
  expect(otherEvents).not.toHaveBeenCalled();
  expect(lost).not.toHaveBeenCalled();
  expect((await other.call('hello')).protocolVersion).toBe(1);
  await client.watch('large', false);
  const count = events.mock.calls.length;
  await change('low');
  expect(events).toHaveBeenCalledTimes(count);
}, 30000);
