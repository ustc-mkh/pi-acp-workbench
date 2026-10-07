import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionPreferences } from '../src/session-preferences';
import { startRustService } from './rust-service';
import type { ChatState, Snapshot } from '../src/shared';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'pi-preferences-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const settings = (
  model = 'other',
  thinking = 'high',
): Pick<ChatState, 'harness' | 'configs' | 'modes'> => ({
  harness: 'pi',
  configs: [
    { id: 'model', name: 'Model', type: 'select', currentValue: model, options: [] },
    { id: 'thinking', name: 'Thinking', type: 'select', currentValue: thinking, options: [] },
    {
      id: 'permissions',
      name: 'Permissions',
      category: 'mode',
      type: 'select',
      currentValue: 'full-access',
      options: [],
    },
  ],
});
it('stores only atomic model/thinking pairs, isolated by harness and shared across instances', async () => {
  const root = await directory(),
    a = new SessionPreferences(root),
    b = new SessionPreferences(root);
  expect(await a.read('pi')).toEqual([]);
  await a.save('pi', settings());
  await b.save('codex', settings('default', 'low'));
  expect(await b.read('pi')).toEqual([
    { kind: 'model', value: 'other' },
    { kind: 'thinking', value: 'high' },
  ]);
  expect(await a.read('codex')).toEqual([
    { kind: 'model', value: 'default' },
    { kind: 'thinking', value: 'low' },
  ]);
  expect((await stat(join(root, 'pi.json'))).mode & 0o777).toBe(0o600);
  await a.save('pi', { harness: 'pi' });
  expect(await b.read('pi')).toHaveLength(2);
  await Promise.all([a.save('pi', settings('A', 'low')), b.save('pi', settings('B', 'high'))]);
  expect([
    [
      { kind: 'model', value: 'A' },
      { kind: 'thinking', value: 'low' },
    ],
    [
      { kind: 'model', value: 'B' },
      { kind: 'thinking', value: 'high' },
    ],
  ]).toContainEqual(await a.read('pi'));
});
it.each([
  'broken',
  JSON.stringify({ version: 0, preferences: [] }),
  JSON.stringify({ version: 1, preferences: [{ kind: 'mode', value: 'full-access' }] }),
])('preserves invalid preferences instead of replacing them (%s)', async (text) => {
  const root = await directory(),
    store = new SessionPreferences(root),
    file = join(root, 'pi.json');
  await writeFile(file, text);
  await expect(store.read('pi')).rejects.toThrow('原文件未修改');
  await expect(store.save('pi', settings())).rejects.toThrow('原文件未修改');
  expect(await readFile(file, 'utf8')).toBe(text);
});
it('Pi service shares selections across directories and restart without changing restored sessions', async () => {
  const root = await directory(),
    other = await directory(),
    preferences = new SessionPreferences(join(root, 'preferences'));
  const config = {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context-native'],
    env: { PI_TEST_AUDIT: join(root, 'audit') },
    maxWorkers: 2,
    idleMs: 900000,
  };
  let service = await startRustService(root, config);
  cleanups.push(() => service.stop());
  const first = await service.call<Snapshot>('create', { cwd: root }, 'new-1');
  const set = (configId: string, value: string) =>
    service.call(
      'request',
      { sessionId: first.id, method: 'session/set_config_option', params: { configId, value } },
      `set-${configId}`,
    );
  await set('model', 'other');
  await set('thinking', 'high');
  expect(await preferences.read('pi')).toEqual([
    { kind: 'model', value: 'other' },
    { kind: 'thinking', value: 'high' },
  ]);
  await service.stop();
  service = await startRustService(root, config);
  const second = await service.call<Snapshot>('create', { cwd: other }, 'new-2');
  expect(second.configs?.map((c) => c.currentValue)).toEqual(['other', 'high']);
  await service.call(
    'request',
    {
      sessionId: second.id,
      method: 'session/set_config_option',
      params: { configId: 'model', value: 'default' },
    },
    'second-model',
  );
  const restored = (await service.call('state', { sessionId: first.id }, 'read-1')) as {
    snapshot: Snapshot;
  };
  expect(restored.snapshot.configs?.map((c) => c.currentValue)).toEqual(['other', 'high']);
  expect((await preferences.read('pi'))[0].value).toBe('default');
  // Actually using the older conversation makes its pair the latest used one.
  await service.call(
    'prompt',
    { sessionId: first.id, prompt: [{ type: 'text', text: 'hello' }], source: 'telegram' },
    'phone-turn',
  );
  expect(await preferences.read('pi')).toEqual([
    { kind: 'model', value: 'other' },
    { kind: 'thinking', value: 'high' },
  ]);
}, 15000);
it('restores the saved pair when a new worker returns adapter defaults', async () => {
  const root = await directory(),
    preferences = new SessionPreferences(join(root, 'preferences'));
  await preferences.save('pi', settings());
  // Non-native mock deliberately returns default/low whenever loaded in a new process.
  const config = {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 1,
    idleMs: 900000,
  };
  let service = await startRustService(root, config);
  cleanups.push(() => service.stop());
  const first = await service.call<Snapshot>('create', { cwd: root }, 'create-first');
  expect(first.configs?.map((c) => c.currentValue)).toEqual(['other', 'high']);
  await service.stop();
  service = await startRustService(root, config);
  await service.call(
    'prompt',
    { sessionId: first.id, prompt: [{ type: 'text', text: 'hello' }], source: 'desktop' },
    'use-first',
  );
  expect(await preferences.read('pi')).toEqual([
    { kind: 'model', value: 'other' },
    { kind: 'thinking', value: 'high' },
  ]);
  const second = await service.call<Snapshot>('create', { cwd: root }, 'create-second');
  expect(second.configs?.map((c) => c.currentValue)).toEqual(['other', 'high']);
}, 15000);
it('Pi service warns about unavailable saved values without destroying the saved pair', async () => {
  const root = await directory(),
    preferences = new SessionPreferences(join(root, 'preferences'));
  await preferences.save('pi', settings('removed', 'missing'));
  const service = await startRustService(root, {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 1,
    idleMs: 900000,
  });
  cleanups.push(() => service.stop());
  const index = await service.call<Snapshot>('create', { cwd: root }, 'new');
  const { snapshot: result } = (await service.call('state', { sessionId: index.id }, 'read')) as {
    snapshot: Snapshot;
  };
  expect(result.entries[0]).toMatchObject({
    role: 'notice',
    text: expect.stringContaining('上次的设置当前不可用'),
  });
  expect(result.configs?.map((c) => c.currentValue)).toEqual(['default', 'low']);
  expect((await preferences.read('pi'))[0].value).toBe('removed');
});
