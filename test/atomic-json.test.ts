import { afterEach, expect, it, vi } from 'vitest';
const { steps, failure } = vi.hoisted(() => ({ steps: [] as string[], failure: { sync: false } }));
vi.mock('node:fs/promises', () => ({
  open: vi.fn(async (_path: string, flags: string, mode?: number) => {
    const kind = flags === 'wx' ? 'file' : 'directory';
    steps.push(`open:${kind}`);
    if (kind === 'file') expect(mode).toBe(0o600);
    return {
      writeFile: async () => {
        steps.push('write');
      },
      sync: async () => {
        steps.push(`sync:${kind}`);
        if (failure.sync && kind === 'file') throw new Error('sync failed');
      },
      close: async () => {
        steps.push(`close:${kind}`);
      },
    };
  }),
  rename: vi.fn(async () => {
    steps.push('rename');
  }),
  rm: vi.fn(async () => {
    steps.push('cleanup');
  }),
}));
import { writeAtomicJson } from '../src/atomic-json';
afterEach(() => {
  steps.length = 0;
  failure.sync = false;
});
it('syncs the receipt before rename and the directory before reporting success', async () => {
  await writeAtomicJson('/private/receipt.json', { id: 'one' }, true);
  expect(steps).toEqual([
    'open:file',
    'write',
    'sync:file',
    'close:file',
    'rename',
    'open:directory',
    'sync:directory',
    'close:directory',
    'cleanup',
  ]);
});
it('does not publish a receipt when syncing its contents fails', async () => {
  failure.sync = true;
  await expect(writeAtomicJson('/private/receipt.json', { id: 'one' }, true)).rejects.toThrow(
    'sync failed',
  );
  expect(steps).toEqual(['open:file', 'write', 'sync:file', 'close:file', 'cleanup']);
});
it('keeps noncritical periodic writes atomic without forcing disk sync', async () => {
  await writeAtomicJson('/private/progress.json', { text: 'progress' });
  expect(steps).toEqual(['open:file', 'write', 'close:file', 'rename', 'cleanup']);
});
it('checks transaction ownership after syncing and leaves the old index intact on failure', async () => {
  await expect(
    writeAtomicJson('/private/index.json', { sessions: [] }, true, () => {
      steps.push('check');
      throw new Error('lease lost');
    }),
  ).rejects.toThrow('lease lost');
  expect(steps).toEqual(['open:file', 'write', 'sync:file', 'close:file', 'check', 'cleanup']);
});
it('checks ownership immediately before publishing a durable index', async () => {
  await writeAtomicJson('/private/index.json', { sessions: [] }, true, () => steps.push('check'));
  expect(steps.indexOf('check')).toBe(steps.indexOf('rename') - 1);
  expect(steps.indexOf('sync:file')).toBeLessThan(steps.indexOf('check'));
  expect(steps.indexOf('sync:directory')).toBeGreaterThan(steps.indexOf('rename'));
});
