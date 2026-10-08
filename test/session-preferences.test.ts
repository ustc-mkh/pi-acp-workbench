import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionSelectors } from '../src/session-settings';
const modelPreferences = (state: Pick<ChatState, 'configs' | 'modes' | 'harness'>) =>
  sessionSelectors(state)
    .filter((c) => c.kind === 'model' || c.kind === 'thinking')
    .map((c) => ({ kind: c.kind, value: c.current }))
    .sort((a, b) => Number(b.kind === 'model') - Number(a.kind === 'model'));
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
// Seed/read fixtures use the documented disk shape; all runtime writes use RPC.
class PreferencesFixture {
  constructor(private root: string) {}
  async read(harness: string) {
    return JSON.parse(await readFile(join(this.root, `${harness}.json`), 'utf8')).preferences;
  }
  async save(harness: string, state: Pick<ChatState, 'harness' | 'configs' | 'modes'>) {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      join(this.root, `${harness}.json`),
      JSON.stringify({ version: 1, preferences: modelPreferences(state) }),
    );
  }
}
it.each([
  'broken',
  '{"version":0,"preferences":[]}',
  '{"version":1,"preferences":[{"kind":"mode","value":"full-access"}]}',
])('daemon preserves corrupt preferences (%s)', async (text) => {
  const root = await directory();
  await mkdir(join(root, 'preferences'));
  const file = join(root, 'preferences', 'pi.json');
  await writeFile(file, text);
  const service = await startRustService(root, {
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), 'context'],
    maxWorkers: 1,
    idleMs: 900000,
  });
  cleanups.push(() => service.stop());
  await expect(service.call('create', { cwd: root })).rejects.toThrow('原文件未修改');
  expect(await readFile(file, 'utf8')).toBe(text);
});
it('Pi service shares selections across directories and restart without changing restored sessions', async () => {
  const root = await directory(),
    other = await directory(),
    preferences = new PreferencesFixture(join(root, 'preferences'));
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
    preferences = new PreferencesFixture(join(root, 'preferences'));
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
    preferences = new PreferencesFixture(join(root, 'preferences'));
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
