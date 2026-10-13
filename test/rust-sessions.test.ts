import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, symlink, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionClient } from '../src/session-wire';
import type { ServiceEvent } from '../src/session-protocol';
import type { ChatState, Entry } from '../src/shared';
import type * as acp from '@agentclientprotocol/sdk';
import type { Inspection } from '../src/telemetry';
import { SharedHistoryStore } from './support/history-fixture';
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
it('names the first input before its answer, persists the choice/title/usage and never prompts twice', async () => {
  const { root, host, client, audit, restart } = await fixture(1, 900000, 'context-title');
  await client.call('setTitleModel', { model: 'p/cheap' });
  const session = await host.create();
  const pending = host.run(session.id, 'wait', { permission: () => {} });
  await vi.waitFor(async () => {
    const state = await host.status(session.id);
    expect(state.busy).toBe(true);
    expect(state.snapshot.title).toBe('合并模型设置页面');
    expect(state.snapshot.entries.filter((e) => e.role === 'user')).toHaveLength(1);
    expect(state.snapshot.entries.some((e) => e.role === 'assistant')).toBe(false);
    expect(
      (await readFile(audit, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((r) => r.method === 'session/prompt'),
    ).toBe(true);
  });
  await host.cancel(session.id);
  await pending;
  const inspect = await client.call<Inspection>('request', {
    sessionId: session.id,
    method: '_pi_workbench/inspect',
    params: {},
  });
  expect(inspect.records).toEqual([
    expect.objectContaining({ kind: 'session-title', model: 'p/cheap', input: 10 }),
  ]);
  await host.run(session.id, 'second task should not rename', { permission: () => {} });
  const requests = (await readFile(audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(requests.filter((r) => r.method === '_pi_workbench/title')).toHaveLength(1);
  expect(requests.filter((r) => r.method === 'session/prompt')).toHaveLength(2);
  expect(
    (await readOutbox(root)).every(
      (event) =>
        event.title === '合并模型设置页面' && event.sessionNumber === session.sessionNumber,
    ),
  ).toBe(true);
  expect(requests.find((r) => r.method === '_pi_workbench/title').params).toMatchObject({
    text: 'wait',
    model: 'p/cheap',
  });
  await restart();
  expect(await client.call('titleSettings')).toEqual({ model: 'p/cheap' });
  expect((await host.status(session.id)).snapshot.title).toBe('合并模型设置页面');
  const cold = await client.call<Inspection>('request', {
    sessionId: session.id,
    method: '_pi_workbench/inspect',
    params: {},
  });
  expect(cold.records).toHaveLength(1);
});
it('retains a short fallback on title failure and does not repeat the failed billable request', async () => {
  const { host, audit } = await fixture(1, 900000, 'context-title-fail');
  const session = await host.create();
  await host.run(
    session.id,
    '请改进模型设置页面，按供应商分组折叠并增加供应商批量操作，让界面简洁易用。',
    { permission: () => {} },
  );
  await host.run(session.id, 'another', { permission: () => {} });
  const state = await host.status(session.id);
  expect([...state.snapshot.title].length).toBeLessThanOrEqual(32);
  expect(state.snapshot.title).toContain('请改进模型设置');
  expect(
    (await readFile(audit, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"method":"_pi_workbench/title"')),
  ).toHaveLength(1);
});
it('does not make a billable title call when automatic naming is disabled', async () => {
  const { host, client, audit } = await fixture(1, 900000, 'context-title');
  await client.call('setTitleModel', { model: 'off' });
  const session = await host.create();
  await host.run(session.id, 'task', { permission: () => {} });
  expect(
    (await readFile(audit, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"method":"_pi_workbench/title"')),
  ).toHaveLength(0);
});
it('reads live inspection without waiting for a managed prompt or changing its busy phase', async () => {
  const { host, service } = await fixture(1, 900000, 'context-title');
  const session = await host.create();
  const pending = host.run(session.id, 'permission', { permission: () => {} });
  void pending.catch(() => {});
  await vi.waitFor(async () =>
    expect((await host.status(session.id)).permissions.length).toBeGreaterThan(0),
  );
  const result = await Promise.race([
    service.call<{ records: unknown[] }>('request', {
      sessionId: session.id,
      method: '_pi_workbench/inspect',
      params: { force: false },
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('inspection waited for prompt')), 1500);
      timer.unref();
    }),
  ]);
  expect(Array.isArray(result.records)).toBe(true);
  const forced = await Promise.race([
    service.call<{ records: unknown[] }>('request', {
      sessionId: session.id,
      method: '_pi_workbench/inspect',
      params: { force: true },
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('forced inspection waited for prompt')),
        1500,
      );
      timer.unref();
    }),
  ]);
  expect(Array.isArray(forced.records)).toBe(true);
  expect((await host.status(session.id)).busy).toBe(true);
  await host.cancel(session.id);
  await pending;
});
it('prefers native adapter titles and keeps them across saves', async () => {
  const { host } = await fixture(1, 900000, 'context-native-title');
  const session = await host.create();
  await host.run(session.id, 'long initial user command', { permission: () => {} });
  expect((await host.status(session.id)).snapshot.title).toBe('原生会话短标题');
  await host.run(session.id, 'another', { permission: () => {} });
  expect((await host.status(session.id)).snapshot.title).toBe('原生会话短标题');
});
it('opens and pages a cold transcript larger than the 64 MiB transport limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-large-history-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entries: Entry[] = Array.from({ length: 70 }, (_, i) => ({
    id: `entry-${i}`,
    role: 'assistant',
    text: 'x'.repeat(1024 * 1024),
  }));
  await new SharedHistoryStore(join(root, 'history')).write({
    id: 'paged',
    harness: 'pi',
    cwd: root,
    title: 'large',
    updated: 1,
    contextComplete: true,
    entries,
  });
  const service = await startRustService(root, {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 1,
    idleMs: 900000,
  });
  cleanup.push(() => service.stop());
  const state = await service.call('state', { sessionId: 'paged' });
  expect(JSON.stringify(state).length).toBeLessThan(16 * 1024 * 1024);
  expect(state.snapshot.historyBefore).toBeGreaterThan(0);
  let page = { entries: state.snapshot.entries, remaining: state.snapshot.historyBefore! };
  const ids = new Set(page.entries.map((e) => e.id));
  while (page.remaining > 0) {
    page = await service.call('historyPage', { sessionId: 'paged', beforeId: page.entries[0].id });
    for (const entry of page.entries) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
    }
  }
  expect(ids.size).toBe(70);
  await expect(
    service.call('historyPage', { sessionId: 'paged', beforeId: 'missing' }),
  ).rejects.toThrow('锚点');
}, 30000);

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
        harness: 'pi',
        update: () => {},
        closed: () => {},
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
  const { root, host, client, service, audit } = await fixture(1, 1000);
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
  // Lifetime tiers are day-scale; pressure from a new session evicts the idle worker.
  await client.call('create', { cwd: root });
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
  let permission!: ChatState['permissions'][number];
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
  const inspection = await client.call<Inspection>(
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
  const point = inspection.forkPoints!.find((p) => p.role === 'assistant');
  const params = { sessionId: session.id, method: '_pi_workbench/fork', params: point };
  const fork = await client.call<{ sessionId: string }>('request', params, 'fork-once', 0);
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
  const state = await client.call('state', { sessionId: fork.sessionId });
  expect(state.snapshot.configs![0].currentValue).toBe('default');
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

it('persists large create/settings results and replays them after restart or deletion without new side effects', async () => {
  const { root, client, socket, audit, restart } = await fixture(
    2,
    900000,
    'context-large-catalogue',
  );
  const params = { cwd: root, harness: 'pi' };
  const created = await client.call('create', params, 'large-create');
  expect(Buffer.byteLength(JSON.stringify(created))).toBeGreaterThan(256 * 1024);
  expect(await client.call('create', params, 'large-create')).toEqual(created);
  expect(await client.call('list')).toHaveLength(1);
  const setting = {
    sessionId: created.id,
    method: 'session/set_config_option',
    params: { sessionId: created.id, configId: 'model', value: 'other' },
  };
  const changed = await client.call<acp.SetSessionConfigOptionResponse>(
    'request',
    setting,
    'large-setting',
  );
  expect(changed.configOptions[0].currentValue).toBe('other');
  expect(Buffer.byteLength(JSON.stringify(changed))).toBeGreaterThan(256 * 1024);
  const before = await readFile(audit, 'utf8');
  client.dispose();
  await restart();
  const cold = new SessionClient(socket);
  cleanup.push(() => cold.dispose());
  expect(await cold.call('create', params, 'large-create')).toEqual(created);
  expect(await cold.call('request', setting, 'large-setting')).toEqual(changed);
  expect(await readFile(audit, 'utf8')).toBe(before);
  await cold.call('historyRemove', { sessionId: created.id });
  expect(await cold.call('create', params, 'large-create')).toEqual(created);
  expect(await cold.call('list')).toEqual([]); // A cached reply never revives a deleted session.
}, 15000);

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
    expect(entry.diff.contentRef).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.diff.files[0].before).toBeUndefined();
    const full = await service.call('turnDiff', { sessionId: session.id, entryId: entry.id });
    expect(full.files[0]).toMatchObject({
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
    if (outcome === 'normal') {
      const params = { sessionId: session.id, entryId: entry.id };
      expect(await service.call('undoTurn', { ...params, checkOnly: true })).toBe(true);
      expect(await readFile(join(root, 'change.txt'), 'utf8')).toBe('agent final\n');
      expect(await service.call('undoTurn', params, 'undo-once')).toBe(true);
      expect(await readFile(join(root, 'change.txt'), 'utf8')).toBe('preexisting dirty contents\n');
      expect(await service.call('undoTurn', params, 'undo-once')).toBe(true);
      await expect(service.call('undoTurn', params, 'undo-again')).rejects.toThrow();
      expect(await readFile(join(root, '.git/index'))).toEqual(index);
    }
  },
  15000,
);

it('rejects undo while another session owns a task in the same workspace', async () => {
  const { root, host, client, service } = await fixture(2, 900000, 'context-diff');
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await promisify(execFile)('git', ['init', '--quiet', cwd]);
  await writeFile(join(cwd, 'change.txt'), 'before\n');
  const first = await host.create(cwd);
  await client.call('prompt', {
    sessionId: first.id,
    prompt: [{ type: 'text', text: 'edit-workspace' }],
  });
  const entry = (await service.call('state', { sessionId: first.id })).snapshot.entries.at(-1)!;
  const second = await host.create(cwd);
  const running = client.call(
    'prompt',
    { sessionId: second.id, prompt: [{ type: 'text', text: 'wait' }] },
    undefined,
    0,
  );
  await vi.waitFor(async () =>
    expect((await service.call('state', { sessionId: second.id })).busy).toBe(true),
  );
  await expect(
    service.call('undoTurn', { sessionId: first.id, entryId: entry.id }),
  ).rejects.toThrow('工作目录');
  expect(await readFile(join(cwd, 'change.txt'), 'utf8')).toBe('agent final\n');
  await host.cancel(second.id);
  await running;
}, 15000);

it('uses arbitrary directories from desktop and Telegram without workspace registration', async () => {
  const { root, client, host } = await fixture();
  const directory = join(root, 'unlisted project'),
    alias = join(root, 'project-link'),
    file = join(root, 'file');
  await mkdir(directory);
  await symlink(directory, alias);
  await writeFile(file, 'not a directory');
  const desktop = await client.call('create', { cwd: alias });
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

it('publishes live context and terminal output, and retains them after a cold restart', async () => {
  const { host, client, restart, socket } = await fixture(1, 900000, 'context-live');
  const session = await host.create(process.cwd());
  const events: ServiceEvent[] = [];
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
  const live = await client.call('state', { sessionId: session.id });
  expect(
    live.snapshot.entries.find(
      (entry): entry is Extract<Entry, { role: 'tool' }> =>
        entry.role === 'tool' && !!entry.terminal,
    )!.terminal!.output,
  ).toBe('first\nsecond');
  await client.call('cancel', { sessionId: session.id });
  await turn;
  const before = await client.call('state', { sessionId: session.id });
  await restart();
  const cold = new SessionClient(socket);
  cleanup.push(() => cold.dispose());
  const after = await cold.call('state', { sessionId: session.id });
  expect(after.snapshot.usage).toEqual({ used: 1234, size: 200000 });
  expect(after.snapshot.entries).toEqual(before.snapshot.entries);
  expect(after.busy).toBe(false);
});

it('releases the singleton lock when startup fails so a corrected service can restart immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-startup-failure-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'service'));
  const requests = join(root, 'service', 'requests');
  await writeFile(requests, 'blocks receipt directory');
  const config = {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 2,
    idleMs: 900000,
  };
  await expect(startRustService(root, config)).rejects.toThrow('Rust service exited');
  await expect(readFile(join(root, 'service.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(requests);
  const service = await startRustService(root, config);
  cleanup.push(() => service.stop());
  expect(await service.call('list')).toEqual([]);
});

it('consumes durable outbox through the socket across daemon restarts', async () => {
  const { host, client, socket, restart } = await fixture();
  const session = await host.create();
  await client.call(
    'prompt',
    { sessionId: session.id, prompt: [{ type: 'text', text: 'outbox over RPC' }] },
    'rpc-outbox',
  );
  const delivery = (await client.call('events.next', {})) as {
    cursor: string;
    token: string;
    event: { id: string; sessionId: string; status: string; text: string };
  };
  expect(delivery.event.sessionId).toBe(session.id);
  expect(delivery.event.status).toBe('completed');
  expect(delivery.event.text).toContain('数学 $x^2$');
  expect(await client.call('events.next', { cursor: delivery.cursor })).toBeNull();
  expect(await client.call('events.ack', { id: delivery.event.id, token: 'stale' })).toBe(false);
  client.dispose();
  await restart();
  const resumed = new SessionClient(socket);
  cleanup.push(() => resumed.dispose());
  expect(await resumed.call('events.next', {})).toEqual(delivery);
  expect(await resumed.call('events.ack', { id: delivery.event.id, token: delivery.token })).toBe(
    true,
  );
  expect(await resumed.call('events.ack', { id: delivery.event.id, token: delivery.token })).toBe(
    false,
  );
  expect(await resumed.call('events.next', {})).toBeNull();
  expect((await resumed.call('list', {})) as unknown[]).toHaveLength(1);
});
