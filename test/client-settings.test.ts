import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { FileClientSettings } from '../src/client-settings';
import { localPreferencesPath } from '../src/local-preferences';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-client-settings-'));
  roots.push(root);
  const file = join(root, 'preferences', 'client-settings.json');
  return { file, store: new FileClientSettings(file) };
}
it('uses a fixed account directory rather than a workspace, profile, or Pi agent override', () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '/some/other/pi');
  expect(localPreferencesPath('price-overrides.json')).toBe(
    join(homedir(), '.pi', 'pi-acp-workbench', 'preferences', 'price-overrides.json'),
  );
});
it('persists the selected Agent across independent clients', async () => {
  const { store, file } = await fixture();
  expect(store.read()).toEqual({});
  await store.setSelectedHarness('codex');
  expect(new FileClientSettings(file).read()).toEqual({ selectedHarness: 'codex' });
  await new FileClientSettings(file).setSelectedHarness('claude');
  expect(store.read()).toEqual({ selectedHarness: 'claude' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    version: 1,
    selectedHarness: 'claude',
  });
});
it('serializes concurrent clients and leaves a valid complete settings file', async () => {
  const { file } = await fixture();
  await Promise.all(
    ['pi', 'codex', 'claude'].map((h) =>
      new FileClientSettings(file).setSelectedHarness(h as 'pi' | 'codex' | 'claude'),
    ),
  );
  expect(['pi', 'codex', 'claude']).toContain(new FileClientSettings(file).read().selectedHarness);
});
it('refuses malformed and oversized settings without replacing their bytes', async () => {
  const { store, file } = await fixture();
  await store.setSelectedHarness('pi');
  for (const body of [
    '{broken',
    JSON.stringify({ version: 1, selectedHarness: 'invalid' }),
    ' '.repeat(4097),
  ]) {
    await writeFile(file, body);
    expect(() => store.read()).toThrow('损坏');
    await expect(store.setSelectedHarness('codex')).rejects.toThrow('损坏');
    expect(await readFile(file, 'utf8')).toBe(body);
  }
});
it('rejects file symlinks and does not recreate a previously observed deleted file', async () => {
  const { store, file } = await fixture();
  await store.setSelectedHarness('pi');
  const alias = `${file}.alias`;
  await symlink(file, alias);
  expect(() => new FileClientSettings(alias).read()).toThrow('无法读取');
  await rm(file);
  await expect(store.setSelectedHarness('codex')).rejects.toThrow('无法读取');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
