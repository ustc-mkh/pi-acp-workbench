import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionClient } from '../src/session-wire';
import { SharedHistoryStore } from '../src/shared-history';
import { DesktopTelegramTurn, TelegramEvents } from '../src/telegram-events';
import { TelegramApi } from '../src/telegram-api';
import { TelegramStream } from '../src/telegram-stream';
import { initialState } from '../src/state';
import { startRustService } from './rust-service';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
// Relay/outbox references remain until their own Rust fault coverage is migrated.
it('coalesces stalled outbox writes and still flushes the final answer', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  const events = new TelegramEvents('/unused');
  const write = vi
    .spyOn(events, 'write')
    .mockImplementationOnce(() => first)
    .mockResolvedValue(undefined);
  const state = { ...initialState(), sessionId: 'one' };
  const turn = new DesktopTelegramTurn(events, state, '/work', 0, () => {});
  for (let i = 0; i < 50; i++) {
    state.entries = [{ id: 'answer', role: 'assistant', text: `version ${i}` }];
    turn.update();
    await vi.advanceTimersByTimeAsync(2500);
  }
  expect(write).toHaveBeenCalledTimes(1);
  const finishing = turn.finish(undefined, 'end_turn');
  release();
  await finishing;
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1][0]).toMatchObject({ text: 'version 49', status: 'completed' });
});
it('keeps only a bounded Telegram preview and rejects an overflowing send queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetcher = vi.fn(async () => {
    await gate;
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  const api = new TelegramApi('test-token', 0, fetcher as unknown as typeof fetch);
  cleanup.push(() => api.dispose());
  const stream = new TelegramStream(api, 1, 1, 100000);
  cleanup.push(() => stream.dispose());
  stream.update('a'.repeat(8 * 1024 * 1024));
  expect((stream as any).text.length).toBeLessThan(3900);
  const sends = Array.from({ length: 100 }, () =>
    api.call('sendMessage', { text: 'x' }).then(
      () => true,
      () => false,
    ),
  );
  release();
  expect((await Promise.all(sends)).filter(Boolean)).toHaveLength(64);
  expect((api as any).queued).toBe(0);
});
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
