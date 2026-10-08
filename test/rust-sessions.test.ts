import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, symlink, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionClient } from '../src/session-wire';
import { SharedHistoryStore } from '../src/shared-history';
import { startRustService } from './rust-service';
import { requestFingerprint, workerPids, readOutbox } from './rust-utils';
import { PhoneClient } from './phone-client';
import { RemoteAgent } from '../src/remote-agent';
import { createHash } from 'node:crypto';
import { writeAtomicJson } from '../src/atomic-json';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(maxWorkers = 2, idleMs = 900000, mode = 'context') {
  const root = await mkdtemp(join(tmpdir(), 'pi-service-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, 'service', 'sessions.sock'),
    audit = join(root, 'audit.jsonl');
  const config = {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), mode],
    env: { PI_TEST_AUDIT: audit },
    maxWorkers,
    idleMs,
  };
  const service = await startRustService(root, config);
  cleanup.push(() => service.stop());
  const restart = async () => {
    await service.stop();
    const next = await startRustService(root, config);
    cleanup.push(() => next.stop());
    return next;
  };
  const host = new PhoneClient(root, socket);
  cleanup.push(() => host.dispose());
  const client = new SessionClient(socket);
  cleanup.push(() => client.dispose());
  return { root, service, host, client, socket, audit, restart };
}
// Workspace policy/alias/symlink coverage belongs to the real Rust relay contract.
it('rejects unknown service methods through the real Rust socket', async () => {
  const { client } = await fixture();
  await expect(client.call('nope', { sessionId: 'x' })).rejects.toMatchObject({
    code: 'unknown_method',
  });
});
it('shares a running task between desktop and phone; detaching desktop does not kill Pi', async () => {
  const { root, host, socket, client } = await fixture();
  const state = vi.fn(),
    agent = new RemoteAgent(
      {
        cwd: root,
        command: 'unused',
        args: [],
        update: () => {},
        permission: vi.fn(),
        closed: () => {},
        log: () => {},
      },
      state,
      socket,
    );
  cleanup.push(() => agent.dispose());
  await agent.initialize();
  const session = await agent.createSession();
  const pending = agent.prompt(session.sessionId, [{ type: 'text', text: 'wait' }]);
  const rejected = expect(pending).rejects.toThrow('不会自动重发');
  await vi.waitFor(async () => expect((await host.status(session.sessionId)).busy).toBe(true));
  agent.dispose();
  await rejected;
  expect((await host.status(session.sessionId)).busy).toBe(true);
  await host.cancel(session.sessionId);
  await vi.waitFor(async () => expect((await host.status(session.sessionId)).busy).toBe(false));
  const result = await host.run(session.sessionId, '中文😀', { permission: () => {} });
  expect(result.status).toBe('completed');
  expect(
    (await host.history(session.sessionId)).some((e) => 'text' in e && e.text === '中文😀'),
  ).toBe(true);
  await expect(client.call('create', { cwd: '/forbidden' })).rejects.toThrow();
}, 15000);
it('deduplicates requests, serializes a session, bounds workers, and reclaims idle Pi', async () => {
  const { host, client, service, audit } = await fixture(1, 1000);
  const a = await host.create(),
    b = await host.create();
  const first = client.call(
    'prompt',
    { sessionId: a.id, prompt: [{ type: 'text', text: 'wait' }] },
    'once',
    0,
  );
  await vi.waitFor(async () =>
    expect((await readFile(audit, 'utf8')).includes('"text":"wait"')).toBe(true),
  );
  const queued = client.call(
    'prompt',
    { sessionId: b.id, prompt: [{ type: 'text', text: 'second' }] },
    'second',
    0,
  );
  const seenWorkers = await workerPids(service.child.pid!);
  expect(seenWorkers).toHaveLength(1);
  const duplicate = service.call(
    'prompt',
    { sessionId: a.id, prompt: [{ type: 'text', text: 'wait' }] },
    'once',
  );
  await expect(
    service.call('prompt', { sessionId: b.id, prompt: [{ type: 'text', text: 'wait' }] }, 'once'),
  ).rejects.toThrow('请求 ID');
  await expect(
    service.call(
      'prompt',
      { sessionId: a.id, prompt: [{ type: 'text', text: 'different' }] },
      'once',
    ),
  ).rejects.toThrow('请求 ID');
  await host.cancel(a.id);
  await first;
  await duplicate;
  await queued;
  const wire = await readFile(audit, 'utf8');
  expect(
    wire.split('\n').filter((l) => l.includes('session/prompt') && l.includes('"text":"wait"')),
  ).toHaveLength(1);
  const remaining = await workerPids(service.child.pid!);
  expect(remaining.length).toBeLessThanOrEqual(1);
  await vi.waitFor(async () => expect(await workerPids(service.child.pid!)).toEqual([]), {
    timeout: 6000,
  });
  for (const pid of new Set([...seenWorkers, ...remaining]))
    expect(() => process.kill(pid, 0)).toThrow();
  const before = await readFile(audit, 'utf8');
  await client.call('state', { sessionId: a.id });
  expect(await readFile(audit, 'utf8')).toBe(before);
}, 20000);
it('shares permission tickets and accepts only the first valid response', async () => {
  const { host, client } = await fixture();
  const session = await host.create();
  let permission: any;
  const turn = host.run(session.id, 'permission', {
    permission: (p) => {
      permission = p;
    },
  });
  await vi.waitFor(() => expect(permission).toBeDefined());
  expect(await host.permission(session.id, permission.id, 'invalid')).toBe(false);
  const option = permission.request.options[0].optionId;
  expect(
    await client.call('permission', {
      sessionId: session.id,
      permissionId: permission.id,
      optionId: option,
    }),
  ).toBe(true);
  expect(await host.permission(session.id, permission.id, option)).toBe(false);
  await turn;
}, 15000);

it('marks unfinished durable requests interrupted on restart without re-running tools', async () => {
  const { root, host, audit, restart } = await fixture();
  const session = await host.create();
  const id = 'interrupted-request';
  await writeAtomicJson(
    join(root, 'service', 'requests', createHash('sha256').update(id).digest('hex') + '.json'),
    {
      id,
      sessionId: session.id,
      fingerprint: requestFingerprint('prompt', {
        sessionId: session.id,
        prompt: [{ type: 'text', text: 'never repeat' }],
      }),
      status: 'running',
    },
  );
  const before = await readFile(audit, 'utf8');
  const recovered = await restart();
  await expect(
    recovered.call(
      'prompt',
      { sessionId: session.id, prompt: [{ type: 'text', text: 'never repeat' }] },
      id,
    ),
  ).rejects.toThrow('不会自动重放');
  expect(await readFile(audit, 'utf8')).toBe(before);
  expect((await readOutbox(root))[0]).toMatchObject({
    status: 'failed',
    sessionId: session.id,
  });
}, 10000);
it('loads native fork settings, preserves source history and leaves separate durable sessions', async () => {
  const { host, client, service, audit } = await fixture(1, 900000, 'context-native');
  const session = await host.create();
  await host.run(session.id, 'first', { permission: () => {} });
  const inspection: any = await client.call(
    'request',
    { sessionId: session.id, method: '_pi_workbench/inspect', params: { force: true } },
    undefined,
    0,
  );
  await client.call(
    'request',
    {
      sessionId: session.id,
      method: 'session/set_config_option',
      params: { configId: 'model', value: 'other' },
    },
    undefined,
    0,
  );
  const point = inspection.forkPoints.find((p: any) => p.role === 'assistant');
  const params = { sessionId: session.id, method: '_pi_workbench/fork', params: point };
  const fork: any = await client.call('request', params, 'fork-once', 0);
  const before = await readFile(audit, 'utf8');
  expect(
    await service.call(
      'request',
      { params: point, method: params.method, sessionId: session.id },
      'fork-once',
    ),
  ).toEqual(fork);
  expect(await readFile(audit, 'utf8')).toBe(before);
  await expect(
    service.call(
      'request',
      { ...params, method: 'session/set_mode', params: { modeId: 'other' } },
      'fork-once',
    ),
  ).rejects.toThrow('请求 ID');
  const state: any = await client.call('state', { sessionId: fork.sessionId });
  expect(state.snapshot.configs[0].currentValue).toBe('default');
  expect(await host.list()).toHaveLength(2);
  expect((await host.history(session.id)).some((e) => 'text' in e && e.text === 'first')).toBe(
    true,
  );
}, 15000);

it('does not start a worker when initial receipt storage is unavailable', async () => {
  const { root, service, audit } = await fixture();
  // A real filesystem failure, not a spy on the retired TS journal.
  const requests = join(root, 'service', 'requests');
  await rename(requests, requests + '.backup');
  await writeFile(requests, 'not a directory');
  await expect(service.call('create', { cwd: root }, 'sync-failure')).rejects.toThrow();
  expect(await workerPids(service.child.pid!)).toEqual([]);
  await expect(readFile(audit)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('persists create receipts across service restarts and rejects ID reuse for different payloads', async () => {
  const { root, service, audit, restart } = await fixture();
  const session = await service.call('create', { cwd: root }, 'create-once');
  const before = await readFile(audit, 'utf8');
  const restarted = await restart();
  expect(await restarted.call('create', { cwd: root }, 'create-once')).toEqual(session);
  await expect(
    restarted.call('create', { cwd: join(root, 'other') }, 'create-once'),
  ).rejects.toThrow('请求 ID');
  expect(await readFile(audit, 'utf8')).toBe(before);
  expect(await restarted.call('list')).toHaveLength(1);
}, 10000);

it('never dispatches a prompt if saving its user message fails, and never retries that request ID', async () => {
  const { root, host, service, audit } = await fixture();
  const session = await host.create();
  const conversations = join(root, 'history', 'conversations');
  await rename(conversations, conversations + '.backup');
  await writeFile(conversations, 'not a directory');
  const params = { sessionId: session.id, prompt: [{ type: 'text', text: 'must not execute' }] };
  try {
    await expect(service.call('prompt', params, 'disk-failure')).rejects.toThrow();
  } finally {
    await rm(conversations);
    await rename(conversations + '.backup', conversations);
  }
  await expect(service.call('prompt', params, 'disk-failure')).rejects.toThrow('不会自动重放');
  expect((await readFile(audit, 'utf8')).includes('"method":"session/prompt"')).toBe(false);
}, 10000);

it('propagates terminal outbox failure and tombstones the executed request instead of replaying it', async () => {
  const { root, service, host } = await fixture();
  const session = await host.create();
  const params = { sessionId: session.id, prompt: [{ type: 'text', text: 'wait' }] };
  const task = service.call('prompt', params, 'terminal-outbox-failure').then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await vi.waitFor(async () => expect((await readOutbox(root))[0]?.status).toBe('running'));
  const directory = join(root, 'telegram', 'events');
  await rename(directory, directory + '.backup');
  await writeFile(directory, 'blocked');
  try {
    await host.cancel(session.id);
    const result = await task;
    expect(result.error).toBeTruthy();
    expect((await service.call('state', { sessionId: session.id })).error).toBeTruthy();
    const file = join(
      root,
      'service',
      'requests',
      createHash('sha256').update('terminal-outbox-failure').digest('hex') + '.json',
    );
    expect(JSON.parse(await readFile(file, 'utf8')).status).toBe('interrupted');
  } finally {
    await rm(directory);
    await rename(directory + '.backup', directory);
  }
  await expect(service.call('prompt', params, 'terminal-outbox-failure')).rejects.toThrow(
    '不会自动重放',
  );
}, 10000);

it.each(['normal', 'wait', 'crash'])(
  'persists a final consolidated workspace diff on %s completion',
  async (outcome) => {
    const { root, host, client, service } = await fixture(1, 900000, 'context-diff');
    const git = promisify(execFile);
    await git('git', ['init', '--quiet', root]);
    await writeFile(join(root, '.gitignore'), 'history/\nservice/\ntelegram/\naudit.jsonl*\n');
    await writeFile(join(root, 'change.txt'), 'staged baseline\n');
    await git('git', ['-C', root, 'add', '.']);
    const index = await readFile(join(root, '.git/index'));
    await writeFile(join(root, 'change.txt'), 'preexisting dirty contents\n');
    const session = await host.create();
    const text = outcome === 'normal' ? 'edit-workspace' : `edit-workspace-${outcome}`;
    const task = client
      .call('prompt', { sessionId: session.id, prompt: [{ type: 'text', text }] }, undefined, 0)
      .then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
    if (outcome === 'wait') {
      await vi.waitFor(async () =>
        expect(await readFile(join(root, 'change.txt'), 'utf8')).toBe('agent final\n'),
      );
      await host.cancel(session.id);
    }
    const result = await task;
    if (outcome === 'crash') expect(result.error).toBeTruthy();
    else expect(result.error).toBeUndefined();
    const state = await service.call('state', { sessionId: session.id }),
      entry = state.snapshot.entries.at(-1)!;
    expect(entry.role).toBe('diff');
    if (entry.role !== 'diff') throw new Error('missing diff');
    expect(entry.diff.files.map((file: { path: string }) => file.path)).toEqual([
      'change.txt',
      'created.txt',
    ]);
    expect(entry.diff.files[0]).toMatchObject({
      before: 'preexisting dirty contents\n',
      after: 'agent final\n',
      added: 1,
      removed: 1,
    });
    expect(
      (await new SharedHistoryStore(join(root, 'history')).read(state.snapshot)).entries.at(-1),
    ).toEqual(entry);
    const event = (await readOutbox(root)).at(-1)!;
    expect(event.text).toContain('本轮修改');
    expect(event.text).toContain('change.txt');
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
  },
  15000,
);

it('uses arbitrary directories from desktop and Telegram without workspace registration', async () => {
  const { root, client, host } = await fixture();
  const directory = join(root, 'unlisted project'),
    alias = join(root, 'project-link'),
    file = join(root, 'file');
  await mkdir(directory);
  await symlink(directory, alias);
  await writeFile(file, 'not a directory');
  const desktop: any = await client.call('create', { cwd: alias });
  expect(desktop.cwd).toBe(directory);
  expect((await host.list()).some((s) => s.id === desktop.id)).toBe(true);
  expect((await host.run(desktop.id, 'hello', { permission: () => {} })).status).toBe('completed');
  expect((await host.history(desktop.id)).some((e) => 'text' in e && e.text === 'hello')).toBe(
    true,
  );
  expect((await readOutbox(root))[0].inputText).toBeUndefined();
  await client.call('prompt', {
    sessionId: desktop.id,
    prompt: [{ type: 'text', text: 'desktop input' }],
  });
  expect((await readOutbox(root)).some((e) => e.inputText === 'desktop input')).toBe(true);
  const phone = await host.create(directory);
  expect(phone.cwd).toBe(directory);
  await expect(host.create(file)).rejects.toThrow('工作区不是目录');
  await expect(client.call('create', { cwd: 'relative' })).rejects.toThrow('绝对目录路径');
  await expect(client.call('create', { cwd: join(root, 'missing') })).rejects.toThrow();
}, 15000);

it('shares TS/Rust history transactions, tombstones and live leases under contention', async () => {
  const { root, service, client, host } = await fixture();
  const store = new SharedHistoryStore(join(root, 'history'));
  cleanup.push(() => store.releaseAll());
  const snapshot = (id: string) => ({
    id,
    harness: 'codex' as const,
    cwd: root,
    title: id,
    updated: Date.now(),
    contextComplete: true,
    entries: [{ id: 'u', role: 'user' as const, text: id }],
  });
  const localWrite = async (id: string) => {
    await store.claim(id);
    try {
      return await store.write(snapshot(id));
    } finally {
      await store.release(id);
    }
  };
  const ids = Array.from({ length: 20 }, (_, i) => `workbench:codex:interop-${i}`);
  await Promise.all(
    ids.map((id, i) =>
      i % 2 ? localWrite(id) : service.call('historyWrite', { snapshot: snapshot(id) }),
    ),
  );
  const first = await store.list();
  expect(first).toHaveLength(20);
  expect(new Set(first.map((s) => s.sessionNumber)).size).toBe(20);
  await Promise.all([
    ...ids
      .slice(0, 10)
      .map((id, i) =>
        i % 2 ? store.remove(id) : service.call('historyRemove', { sessionId: id }),
      ),
    ...Array.from({ length: 10 }, (_, i) => localWrite(`workbench:codex:later-${i}`)),
    ...Array.from({ length: 10 }, (_, i) =>
      service.call('historyWrite', { snapshot: snapshot(`workbench:codex:rust-later-${i}`) }),
    ),
  ]);
  const index = JSON.parse(await readFile(join(root, 'history/index.json'), 'utf8'));
  expect(index.sessions).toHaveLength(30);
  expect(index.deleted.sort()).toEqual(ids.slice(0, 10).sort());
  expect(new Set(index.sessions.map((s: any) => s.sessionNumber)).size).toBe(30);
  for (const id of ids.slice(0, 10)) {
    await expect(service.call('historyWrite', { snapshot: snapshot(id) })).rejects.toThrow('删除');
    await expect(localWrite(id)).rejects.toThrow('删除');
  }
  const pi = await host.create();
  const pending = client.call(
    'prompt',
    { sessionId: pi.id, prompt: [{ type: 'text', text: 'wait' }] },
    'interop-pi',
    0,
  );
  await vi.waitFor(async () => expect((await host.status(pi.id)).busy).toBe(true));
  await expect(store.claim(pi.id)).rejects.toThrow('另一个窗口');
  await host.cancel(pi.id);
  await pending;
  await service.stop();
  await store.claim(pi.id);
  await store.release(pi.id);
}, 20000);
it('publishes live context and terminal output, and retains them after a cold restart', async () => {
  const { host, client, restart, socket } = await fixture(1, 900000, 'context-live');
  const session = await host.create(process.cwd());
  const events: any[] = [];
  const watcher = new SessionClient(socket, (event) => events.push(event));
  cleanup.push(() => watcher.dispose());
  await watcher.watch(session.id);
  const turn = client.call(
    'prompt',
    { sessionId: session.id, prompt: [{ type: 'text', text: 'wait' }] },
    undefined,
    0,
  );
  await vi.waitFor(() =>
    expect(
      events.some(
        (event) => event.type === 'state' && event.busy && event.snapshot.usage?.used === 1234,
      ),
    ).toBe(true),
  );
  const live: any = await client.call('state', { sessionId: session.id });
  expect(live.snapshot.entries.find((entry: any) => entry.terminal).terminal.output).toBe(
    'first\nsecond',
  );
  await client.call('cancel', { sessionId: session.id });
  await turn;
  const before: any = await client.call('state', { sessionId: session.id });
  await restart();
  const cold = new SessionClient(socket);
  cleanup.push(() => cold.dispose());
  const after: any = await cold.call('state', { sessionId: session.id });
  expect(after.snapshot.usage).toEqual({ used: 1234, size: 200000 });
  expect(after.snapshot.entries).toEqual(before.snapshot.entries);
  expect(after.busy).toBe(false);
});
