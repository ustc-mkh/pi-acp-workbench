import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUsageStorage } from '../src/usage-storage';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-usage-storage-'));
  roots.push(root);
  return join(root, 'preferences', 'usage.json');
}
it('starts empty without a global file and has no migration API', async () => {
  const file = await fixture();
  const storage = new FileUsageStorage(file);
  expect(storage.get('usageRecords', ['fallback'])).toEqual([]);
  expect(storage.get('usageTitles', { old: 'fallback' })).toEqual({});
  expect(storage.get('usageSessionNumbers', { old: 1 })).toEqual({});
  expect('migrate' in storage).toBe(false);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('persists and restores usage exclusively from the global file', async () => {
  const file = await fixture();
  const storage = new FileUsageStorage(file);
  await storage.update('usageTitles', { session: 'Global session' });
  await storage.update('usageSessionNumbers', { session: 3 });
  const restored = new FileUsageStorage(file);
  expect(restored.get('usageTitles', {})).toEqual({ session: 'Global session' });
  expect(restored.get('usageSessionNumbers', {})).toEqual({ session: 3 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    version: 1,
    usageRecords: [],
    usageTitles: { session: 'Global session' },
    usageSessionNumbers: { session: 3 },
  });
});
