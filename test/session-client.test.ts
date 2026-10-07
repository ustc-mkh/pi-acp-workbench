import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionClient, WIRE_LIMITS } from '../src/session-wire';
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// Transport-only fixture. No sessions, persistence, worker execution or service implementation.
async function fixture(handle: (request: any, socket: Socket) => Promise<unknown>) {
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
        const request = JSON.parse(buffer.slice(0, end));
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
  const client = new SessionClient(path);
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
    await vi.waitFor(() => expect((client as any).pending.size).toBe(WIRE_LIMITS.pending));
  } finally {
    release();
  }
  expect((await Promise.all(sends)).filter(Boolean)).toHaveLength(WIRE_LIMITS.pending);
  const circular: any = {};
  circular.self = circular;
  await expect(client.call('bad', circular)).rejects.toThrow();
  expect((client as any).pending.size).toBe(0);
});
it('times out without replaying or breaking later calls, and ignores the late reply', async () => {
  let release!: (value: string) => void;
  const handle = vi.fn(async (request: any) =>
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
  expect((client as any).pending.size).toBe(0);
});
