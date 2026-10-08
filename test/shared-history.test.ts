import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRustService } from './rust-service';
import { RemoteAgent } from '../src/remote-agent';
import type { HarnessId } from '../src/harness';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-unified-history-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worker = {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    env: { PI_TEST_AUDIT: join(root, 'audit') },
  };
  const service = await startRustService(root, {
    ...worker,
    harnesses: { codex: worker, claude: worker },
    maxWorkers: 3,
    idleMs: 1000,
  });
  cleanup.push(() => service.stop());
  const agent = (harness: HarnessId) => {
    const remote = new RemoteAgent(
      { cwd: root, harness, closed: () => {} },
      () => {},
      service.socket,
    );
    cleanup.push(() => remote.dispose());
    return remote;
  };
  return { root, service, agent };
}
it('owns every harness through the same socket, namespaces IDs, and persists settings and prompts', async () => {
  const { root, service, agent } = await fixture();
  const ids: string[] = [];
  for (const harness of ['pi', 'codex', 'claude'] as const) {
    const remote = agent(harness);
    const info = await remote.initialize();
    expect(info.agentCapabilities?._meta?.['session-service']).toMatchObject({
      version: 3,
      authoritative: true,
    });
    const session = await remote.createSession();
    ids.push(session.sessionId);
    await remote.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: 'other',
    });
    await remote.prompt(session.sessionId, [{ type: 'text', text: `${harness} prompt` }]);
    const state = await service.call('state', { sessionId: session.sessionId });
    expect(state.snapshot.harness).toBe(harness);
    expect(state.snapshot.entries).toContainEqual(
      expect.objectContaining({ role: 'user', text: `${harness} prompt` }),
    );
    expect(state.snapshot.entries.at(-1)!.role).toBe('diff');
    expect(
      JSON.parse(await readFile(join(root, 'preferences', `${harness}.json`), 'utf8')).preferences,
    ).toContainEqual(expect.objectContaining({ kind: 'model', value: 'other' }));
  }
  expect(new Set(ids).size).toBe(3);
  expect((await service.call('list')).map((s) => s.harness).sort()).toEqual([
    'claude',
    'codex',
    'pi',
  ]);
  const wire = await readFile(join(root, 'audit'), 'utf8');
  expect(wire).not.toContain('workbench:'); // Standard ACP sees only upstream native IDs.
  await expect(service.call('historyWrite', { snapshot: {} })).rejects.toMatchObject({
    code: 'unknown_method',
  });
});
it.each(['pi', 'codex', 'claude'] as const)(
  'keeps %s work alive when clients detach and rejects deleted sessions',
  async (harness) => {
    const { service, agent } = await fixture();
    const first = agent(harness),
      second = agent(harness);
    await first.initialize();
    const session = await first.createSession();
    await second.initialize();
    await second.createSession(session.sessionId);
    const running = first.prompt(session.sessionId, [{ type: 'text', text: 'wait' }]);
    const detached = expect(running).rejects.toThrow();
    await vi.waitFor(async () =>
      expect((await service.call('state', { sessionId: session.sessionId })).busy).toBe(true),
    );
    first.dispose();
    await detached;
    expect((await second.sync())!.busy).toBe(true);
    await second.cancel(session.sessionId);
    await vi.waitFor(async () => expect((await second.sync())!.busy).toBe(false));
    await service.call('historyRemove', { sessionId: session.sessionId });
    await expect(second.sync()).rejects.toThrow('不存在');
    expect(await service.call('list')).toEqual([]);
  },
);
it('rejects cross-harness attachment before any prompt can be submitted', async () => {
  const { agent } = await fixture();
  const codex = agent('codex'),
    claude = agent('claude');
  await codex.initialize();
  const session = await codex.createSession();
  await claude.initialize();
  await expect(claude.createSession(session.sessionId)).rejects.toThrow('当前 harness');
});
it.each(['pi', 'codex', 'claude'] as const)(
  'preserves cold %s history when native loading fails, without fallback new',
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-load-failure-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const worker = {
      command: process.execPath,
      args: [resolve('test/mock-agent.mjs'), `context-missing-${harness}`],
      env: { PI_TEST_AUDIT: join(root, 'audit') },
    };
    const service = await startRustService(root, {
      ...worker,
      maxWorkers: 1,
      idleMs: 1000,
      harnesses: { codex: worker, claude: worker },
    });
    cleanup.push(() => service.stop());
    const snapshot = await service.call('create', { cwd: root, harness });
    await expect(
      service.call('prompt', {
        sessionId: snapshot.id,
        prompt: [{ type: 'text', text: 'never run' }],
      }),
    ).rejects.toThrow();
    expect((await service.call('list'))[0].id).toBe(snapshot.id);
    expect((await service.call('state', { sessionId: snapshot.id })).snapshot.entries).toEqual(
      snapshot.entries,
    );
    const requests = (await readFile(join(root, 'audit'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.filter((r) => r.method === 'session/new')).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'session/load')).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'session/prompt')).toHaveLength(0);
  },
);
it('negotiates standard adapter capabilities without advertising Pi extensions', async () => {
  const { agent } = await fixture();
  for (const harness of ['codex', 'claude'] as const) {
    const info = await agent(harness).initialize();
    expect(info.agentCapabilities?._meta?.['pi-workbench']).toBeUndefined();
    expect(info.agentCapabilities?.loadSession).toBe(true);
  }
});
