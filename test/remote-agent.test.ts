import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteAgent } from '../src/remote-agent';
import type { ServiceState } from '../src/session-protocol';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
interface WireRequest {
  id: string;
  method: string;
  params: { sessionId: string; enabled?: boolean };
}
const state = (id: string, text: string, busy = false): ServiceState => ({
  snapshot: {
    id,
    harness: 'pi',
    cwd: '/work',
    title: id,
    updated: 1,
    entries: [{ id: 'answer', role: 'assistant', text }],
    configs: [{ id: 'model', name: 'Model', type: 'select', currentValue: text, options: [] }],
  },
  busy,
  permissions: [],
  commands: [],
  plan: [],
});
async function wireFixture(handle: (request: WireRequest, socket: Socket) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'pi-state-order-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'wire.sock'),
    sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as WireRequest;
        buffer = buffer.slice(end + 1);
        void handle(request, socket).then((value) => {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, value }) + '\n');
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const updates: ServiceState[] = [];
  const agent = new RemoteAgent(
    { cwd: root, harness: 'pi', closed: () => {} },
    (value) => updates.push(value),
    path,
  );
  cleanup.push(() => agent.dispose());
  return { agent, updates };
}

it('does not let a late state query roll back a newer subscribed push', async () => {
  let hold = false,
    reply!: (value: ServiceState) => void,
    socket!: Socket;
  const old = state('one', 'old'),
    latest = state('one', 'new', true);
  const { agent, updates } = await wireFixture(async (request, connection) => {
    if (request.method === '_watch') return true;
    if (!hold) return old;
    socket = connection;
    return new Promise<ServiceState>((resolve) => {
      reply = resolve;
    });
  });
  await agent.createSession('one');
  hold = true;
  const pending = agent.sync();
  await vi.waitFor(() => expect(reply).toBeDefined());
  socket.write(JSON.stringify({ event: { ...latest, type: 'state', revision: 1 } }) + '\n');
  await vi.waitFor(() => expect(agent.latest?.busy).toBe(true));
  reply(old);
  await pending;
  expect(agent.latest?.snapshot.entries[0]).toMatchObject({ text: 'new' });
  expect(updates.at(-1)?.busy).toBe(true);
});

it('ignores older concurrent queries and replies from a previous attachment', async () => {
  let hold = false;
  const replies: ((value: ServiceState) => void)[] = [];
  const { agent } = await wireFixture(async (request) => {
    if (request.method === '_watch') return true;
    if (!hold || request.params.sessionId === 'two')
      return state(request.params.sessionId, 'attached');
    return new Promise<ServiceState>((resolve) => replies.push(resolve));
  });
  await agent.createSession('one');
  hold = true;
  const first = agent.sync(),
    second = agent.sync();
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  replies[1](state('one', 'new'));
  await second;
  replies[0](state('one', 'old'));
  await first;
  expect(agent.latest?.snapshot.entries[0]).toMatchObject({ text: 'new' });
  const stale = agent.sync();
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  await agent.createSession('two');
  replies[2](state('one', 'stale'));
  await stale;
  expect(agent.latest?.snapshot.id).toBe('two');
});

it('does not let an older attachment query replace a newer session', async () => {
  let reply!: (value: ServiceState) => void;
  const watches: string[] = [];
  const { agent } = await wireFixture(async (request) => {
    if (request.method === '_watch') {
      watches.push(request.params.sessionId);
      return true;
    }
    if (request.params.sessionId === 'one')
      return new Promise<ServiceState>((resolve) => (reply = resolve));
    return state('two', 'new attachment');
  });
  const first = agent.createSession('one');
  const rejected = expect(first).rejects.toThrow('取代');
  await vi.waitFor(() => expect(reply).toBeDefined());
  await agent.createSession('two');
  reply(state('one', 'late attachment'));
  await rejected;
  expect(agent.latest?.snapshot.id).toBe('two');
  expect(watches).toEqual(['two']);
});

it('rejects an attachment superseded while its watch acknowledgement is pending', async () => {
  let release!: (value: boolean) => void;
  const { agent } = await wireFixture(async (request) => {
    if (request.method === '_watch') {
      if (request.params.sessionId === 'one' && request.params.enabled === true)
        return new Promise<boolean>((resolve) => (release = resolve));
      return true;
    }
    return state(request.params.sessionId, request.params.sessionId);
  });
  const first = agent.createSession('one');
  const rejected = expect(first).rejects.toThrow('取代');
  await vi.waitFor(() => expect(release).toBeDefined());
  await agent.createSession('two');
  release(true);
  await rejected;
  expect(agent.latest?.snapshot.id).toBe('two');
});

it('returns selectors from the synchronized state, not the earlier pre-watch query', async () => {
  let reads = 0;
  const { agent } = await wireFixture(async (request) =>
    request.method === '_watch' ? true : state('one', ++reads === 1 ? 'old' : 'new'),
  );
  const session = await agent.createSession('one');
  expect(session.configOptions?.[0].currentValue).toBe('new');
});

it.each([undefined, 1, 2, 3])(
  'rejects service version %s instead of falling back to local writes',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-protocol-version-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socket = join(root, 'service.sock'),
      methods: string[] = [];
    const server = createServer((connection) => {
      let buffer = '';
      connection.on('data', (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        methods.push(request.method);
        connection.write(
          JSON.stringify({
            id: request.id,
            value: {
              protocolVersion: 1,
              agentCapabilities: {
                _meta: {
                  'session-service': { version },
                  'pi-workbench': { version: 2, history: true },
                },
              },
            },
          }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const agent = new RemoteAgent(
      { cwd: root, harness: 'codex', closed: () => {} },
      () => {},
      socket,
    );
    cleanup.push(() => agent.dispose());
    await expect(agent.initialize()).rejects.toThrow('v4');
    expect(methods).toEqual(['hello']);
  },
);
