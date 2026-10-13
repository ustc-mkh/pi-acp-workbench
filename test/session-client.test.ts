import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionClient, WIRE_LIMITS } from '../src/session-wire';
import type { ServiceEvent } from '../src/session-protocol';
const cleanup: Array<() => Promise<unknown> | void> = [];
interface TestRequest {
  id: string;
  method: string;
  params: unknown;
}
const pendingCount = (client: SessionClient) =>
  (client as unknown as { pending: ReadonlyMap<string, unknown> }).pending.size;
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// Transport-only fixture. No sessions, persistence, worker execution or service implementation.
async function fixture(
  handle: (request: TestRequest, socket: Socket) => Promise<unknown>,
  event: (value: ServiceEvent) => void = () => {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pi-client-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sockets = new Set<Socket>(),
    path = join(root, 'wire.sock');
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request: TestRequest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        void handle(request, socket).then((value) => {
          if (value !== undefined && !socket.destroyed)
            socket.write(JSON.stringify({ id: request.id, value }) + '\n');
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new SessionClient(path, event);
  cleanup.push(() => client.dispose());
  return client;
}
it('bounds pending requests and releases slots after replies and serialization errors', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client = await fixture(async () => {
    await gate;
    return 'ok';
  });
  const sends = Array.from({ length: WIRE_LIMITS.pending + 1 }, () =>
    client.call('hold', {}, undefined, 0).then(
      () => true,
      () => false,
    ),
  );
  try {
    await vi.waitFor(() => expect(pendingCount(client)).toBe(WIRE_LIMITS.pending));
  } finally {
    release();
  }
  expect((await Promise.all(sends)).filter(Boolean)).toHaveLength(WIRE_LIMITS.pending);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await expect(client.call('bad', circular)).rejects.toThrow();
  expect(pendingCount(client)).toBe(0);
});
it('times out without replaying or breaking later calls, and ignores the late reply', async () => {
  let release!: (value: string) => void;
  const handle = vi.fn(async (request: TestRequest) =>
    request.method === 'slow' ? new Promise<string>((resolve) => (release = resolve)) : 'ok',
  );
  const client = await fixture(handle);
  await expect(client.call('slow', {}, undefined, 50)).rejects.toThrow('slow，等待 0.05 秒');
  expect(await client.call('hello')).toBe('ok');
  release('late');
  expect(await client.call('hello')).toBe('ok');
  expect(handle.mock.calls.filter(([request]) => request.method === 'slow')).toHaveLength(1);
});
it('rejects a fragmented reply cut off by disconnect and releases the pending slot', async () => {
  const client = await fixture(async (request, socket) => {
    socket.end(
      JSON.stringify({
        fragment: JSON.stringify({ id: request.id, value: '中文😀' }).slice(0, 12),
        last: false,
      }) + '\n',
    );
  });
  await expect(client.call('state')).rejects.toThrow('连接已断开');
  expect(pendingCount(client)).toBe(0);
});

it.each([true, false])('accepts in-flight patches while changing watch to %s', async (enabled) => {
  const events: ServiceEvent[] = [];
  let watches = 0;
  const snapshot = {
    id: 'one',
    harness: 'pi',
    cwd: '/work',
    title: 'one',
    updated: 1,
    entries: [],
  };
  const fields = { snapshot, busy: false, permissions: [], commands: [], plan: [] };
  const client = await fixture(
    async (request, socket) => {
      if (request.method !== '_watch') return true;
      if (++watches === 1) {
        socket.write(JSON.stringify({ event: { ...fields, type: 'state', revision: 1 } }) + '\n');
      } else {
        socket.write(
          JSON.stringify({
            event: {
              type: 'statePatch',
              sessionId: 'one',
              baseRevision: 1,
              revision: 2,
              state: fields,
              entries: [],
            },
          }) + '\n',
        );
        if (enabled)
          socket.write(JSON.stringify({ event: { ...fields, type: 'state', revision: 1 } }) + '\n');
      }
      return true;
    },
    (event) => events.push(event),
  );
  await client.watch('one');
  await expect(client.watch('one', enabled)).resolves.toBe(true);
  expect(events).toHaveLength(enabled ? 3 : 2);
  expect(await client.call('hello')).toBe(true);
});

it('gives each partial frame its own deadline when frames share a data chunk', async () => {
  const original = WIRE_LIMITS.partialMs;
  WIRE_LIMITS.partialMs = 1000;
  let socket!: Socket;
  let requestId!: string;
  const client = await fixture(async (request, connection) => {
    socket = connection;
    requestId = request.id;
    connection.write('{"id":');
  });
  const result = client.call<string>('hold', {}, undefined, 0).then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  try {
    await vi.waitFor(() => expect(socket).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Finish an unrelated response and start the requested response in the
    // same write: the second response must not inherit the first deadline.
    socket.write('"unrelated","value":true}\n{"id":');
    await new Promise((resolve) => setTimeout(resolve, 600));
    socket.write(JSON.stringify(requestId) + ',"value":"ok"}\n');
    expect(await result).toEqual({ value: 'ok' });
  } finally {
    WIRE_LIMITS.partialMs = original;
    client.dispose();
  }
});

it('keeps the new baseline when unsubscribe and resubscribe replies arrive together', async () => {
  let watches = 0;
  let disabledId = '';
  const fields = {
    snapshot: { id: 'one', harness: 'pi', cwd: '/work', title: 'one', updated: 1, entries: [] },
    busy: false,
    permissions: [],
    commands: [],
    plan: [],
  };
  const client = await fixture(async (request, socket) => {
    if (request.method !== '_watch') {
      socket.write(
        JSON.stringify({
          event: {
            type: 'statePatch',
            sessionId: 'one',
            baseRevision: 1,
            revision: 2,
            state: fields,
            entries: [],
          },
        }) + '\n',
      );
      return true;
    }
    if (++watches === 1) {
      socket.write(JSON.stringify({ event: { ...fields, type: 'state', revision: 5 } }) + '\n');
      return true;
    }
    if (watches === 2) {
      disabledId = request.id;
      return undefined;
    }
    socket.write(
      [
        { id: disabledId, value: true },
        { event: { ...fields, type: 'state', revision: 1 } },
        { id: request.id, value: true },
      ]
        .map((frame) => JSON.stringify(frame) + '\n')
        .join(''),
    );
    return undefined;
  });
  await client.watch('one');
  await Promise.all([client.watch('one', false), client.watch('one', true)]);
  await expect(client.call('hello')).resolves.toBe(true);
});
