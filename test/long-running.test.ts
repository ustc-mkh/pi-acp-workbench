import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { SessionServer, SessionClient, WIRE_LIMITS } from '../src/session-wire';
import { DesktopTelegramTurn, TelegramEvents } from '../src/telegram-events';
import { TelegramApi } from '../src/telegram-api';
import { TelegramStream } from '../src/telegram-stream';
import { initialState } from '../src/state';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
it('coalesces stalled outbox writes and still flushes the final answer', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  const results = await Promise.all(sends);
  expect(results.filter(Boolean)).toHaveLength(64);
  expect((api as any).queued).toBe(0);
});
it('fragments large history responses and broadcasts only to subscribed sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-wire-history-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const text = '中文😀'.repeat(1800000); // >16 MiB, including multi-byte characters and surrogate pairs.
  const server = new SessionServer(join(root, 'service.sock'), async (method) =>
    method === 'state' ? { text } : 'ok',
  );
  await server.listen();
  cleanup.push(() => server.dispose());
  const events = vi.fn(),
    otherEvents = vi.fn(),
    lost = vi.fn();
  const client = new SessionClient(join(root, 'service.sock'), events, lost),
    other = new SessionClient(join(root, 'service.sock'), otherEvents, lost);
  cleanup.push(() => client.dispose());
  cleanup.push(() => other.dispose());
  await client.watch('large');
  await other.watch('other');
  expect(await client.call('state')).toEqual({ text });
  server.broadcast({ type: 'state', snapshot: { id: 'large', entries: [{ text }] } });
  await vi.waitFor(() => expect(events).toHaveBeenCalledOnce(), { timeout: 10000 });
  expect(events.mock.calls[0][0].snapshot.entries[0].text).toBe(text);
  expect(otherEvents).not.toHaveBeenCalled();
  expect(lost).not.toHaveBeenCalled();
  expect(await other.call('hello')).toBe('ok');
  await client.watch('large', false);
  server.broadcast({ type: 'state', snapshot: { id: 'large' } });
  expect(await client.call('hello')).toBe('ok');
  expect(events).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect((server as any).outgoingBytes).toBe(0));
}, 20000);
it('reports oversized responses without disconnecting unrelated clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-wire-oversize-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const limit = WIRE_LIMITS.responseBytes;
  WIRE_LIMITS.responseBytes = 1024;
  cleanup.push(() => {
    WIRE_LIMITS.responseBytes = limit;
  });
  const server = new SessionServer(join(root, 'service.sock'), async (method) =>
    method === 'large' ? 'x'.repeat(2048) : 'ok',
  );
  await server.listen();
  cleanup.push(() => server.dispose());
  const events = vi.fn(),
    lost = vi.fn();
  const client = new SessionClient(join(root, 'service.sock'), events, lost),
    other = new SessionClient(join(root, 'service.sock'), () => {}, lost);
  cleanup.push(() => client.dispose());
  cleanup.push(() => other.dispose());
  await client.watch('large');
  await other.watch('other');
  await expect(client.call('large')).rejects.toThrow('响应超过');
  server.broadcast({ type: 'state', snapshot: { id: 'large', text: 'x'.repeat(2048) } });
  await vi.waitFor(() => expect(events).toHaveBeenCalledOnce());
  expect(events.mock.calls[0][0].type).toBe('serviceError');
  expect(await other.call('hello')).toBe('ok');
  expect(await client.call('hello')).toBe('ok');
  expect(lost).not.toHaveBeenCalled();
});
it('bounds socket connections and in-flight requests, releases them, and handles serialization errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-wire-bounds-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = new SessionServer(join(root, 'service.sock'), async () => {
    await gate;
    return '中文😀';
  });
  await server.listen();
  cleanup.push(() => server.dispose());
  const client = new SessionClient(join(root, 'service.sock'));
  cleanup.push(() => client.dispose());
  const sends = Array.from({ length: WIRE_LIMITS.pending + 1 }, () =>
    client.call('wait', {}, undefined, 0).then(
      () => true,
      () => false,
    ),
  );
  try {
    await vi.waitFor(() => expect((server as any).pending).toBe(WIRE_LIMITS.pending));
  } finally {
    release();
  }
  const results = await Promise.all(sends);
  expect(results.filter(Boolean)).toHaveLength(WIRE_LIMITS.pending);
  const circular: any = {};
  circular.self = circular;
  await expect(client.call('bad', circular, undefined, 0)).rejects.toThrow();
  expect((client as any).pending.size).toBe(0);
  client.dispose();
  await vi.waitFor(() => expect((server as any).sockets.size).toBe(0));
  const sockets: Socket[] = [];
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
  });
  for (let i = 0; i < WIRE_LIMITS.connections; i++)
    await new Promise<void>((resolve, reject) => {
      const s = createConnection(join(root, 'service.sock'));
      sockets.push(s);
      s.on('error', reject);
      s.once('connect', resolve);
    });
  await vi.waitFor(() => expect((server as any).sockets.size).toBe(WIRE_LIMITS.connections));
  await new Promise<void>((resolve) => {
    const s = createConnection(join(root, 'service.sock'));
    s.on('error', () => {});
    s.once('close', resolve);
  });
  for (const s of sockets) s.destroy();
  await vi.waitFor(() => expect((server as any).sockets.size).toBe(0));
  expect((server as any).pending).toBe(0);
  expect((server as any).pendingBytes).toBe(0);
  expect((server as any).bufferedBytes).toBe(0);
}, 10000);
it('identifies timed-out requests without replaying them or breaking other service calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-wire-timeout-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let release!: (value: string) => void;
  const handle = vi.fn(async (method: string) =>
    method === 'slow'
      ? new Promise<string>((resolve) => {
          release = resolve;
        })
      : 'ok',
  );
  const server = new SessionServer(join(root, 'service.sock'), handle);
  await server.listen();
  cleanup.push(() => server.dispose());
  const client = new SessionClient(join(root, 'service.sock'));
  cleanup.push(() => client.dispose());
  await expect(client.call('slow', {}, undefined, 50)).rejects.toThrow('slow，等待 0.05 秒');
  expect(await client.call('hello')).toBe('ok');
  release('late result');
  expect(await client.call('hello')).toBe('ok');
  expect(handle.mock.calls.filter(([method]) => method === 'slow')).toHaveLength(1);
});
