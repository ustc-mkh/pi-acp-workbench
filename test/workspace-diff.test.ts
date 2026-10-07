import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceDiff, DIFF_LIMITS } from '../src/workspace-diff';
const execute = promisify(execFile),
  roots: string[] = [],
  limits = { ...DIFF_LIMITS };
afterEach(async () => {
  Object.assign(DIFF_LIMITS, limits);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory(git = true) {
  const root = await mkdtemp(join(tmpdir(), 'pi-turn-test-'));
  roots.push(root);
  if (git) await execute('git', ['init', '--quiet', root]);
  return root;
}
async function finish(turn: WorkspaceDiff) {
  const entry = await turn.finish();
  if (entry.role !== 'diff') throw new Error('Expected a diff entry');
  return entry.diff;
}
it('compares pre-turn worktree contents, consolidates repeated edits, and leaves the index untouched', async () => {
  const root = await directory();
  await writeFile(join(root, 'tracked.txt'), 'committed baseline\n');
  await execute('git', ['-C', root, 'add', 'tracked.txt']);
  const index = await readFile(join(root, '.git/index'));
  await writeFile(join(root, 'tracked.txt'), 'already dirty\nkeep\n');
  await writeFile(join(root, 'delete.txt'), 'remove me\n');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  const turn = await WorkspaceDiff.begin(root);
  await writeFile(join(root, 'tracked.txt'), 'intermediate edit\n');
  await writeFile(join(root, 'tracked.txt'), 'already dirty\nnew\n');
  await writeFile(join(root, '中文 name.txt'), 'new file\n');
  await writeFile(join(root, 'ignored.txt'), 'not collected');
  await rm(join(root, 'delete.txt'));
  const diff = await finish(turn);
  expect(diff.status).toBe('complete');
  expect(diff.files).toHaveLength(3);
  expect(diff.files.find((file) => file.path === 'tracked.txt')).toMatchObject({
    status: 'modified',
    before: 'already dirty\nkeep\n',
    after: 'already dirty\nnew\n',
    added: 1,
    removed: 1,
  });
  expect(diff.files.find((file) => file.path === 'delete.txt')).toMatchObject({
    status: 'deleted',
    after: '',
    removed: 1,
  });
  expect(diff.files.find((file) => file.path === '中文 name.txt')).toMatchObject({
    status: 'added',
    before: '',
    added: 1,
  });
  expect(diff.files.some((file) => file.patch?.includes('committed baseline'))).toBe(false);
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  const next = await WorkspaceDiff.begin(root);
  await writeFile(join(root, 'tracked.txt'), 'temporary');
  await writeFile(join(root, 'tracked.txt'), 'already dirty\nnew\n');
  expect((await finish(next)).files).toEqual([]);
});
it('keeps nested workspaces scoped and includes file mode changes', async () => {
  const root = await directory(),
    nested = join(root, 'nested');
  await mkdir(nested);
  await writeFile(join(root, 'outside'), 'before');
  await writeFile(join(nested, 'script'), 'echo ok\n');
  const turn = await WorkspaceDiff.begin(nested);
  await writeFile(join(root, 'outside'), 'after');
  await chmod(join(nested, 'script'), 0o755);
  const diff = await finish(turn);
  expect(diff.files).toHaveLength(1);
  expect(diff.files[0]).toMatchObject({ path: 'script', added: 0, removed: 0 });
  expect(diff.files[0].oldMode).not.toBe(diff.files[0].newMode);
});
it('reports missing Git worktrees and unavailable baselines instead of attributing the entire workspace', async () => {
  const root = await directory(false);
  const turn = await WorkspaceDiff.begin(root);
  await writeFile(join(root, 'new'), 'new');
  expect(await finish(turn)).toMatchObject({ status: 'unavailable', files: [] });
});
it('does not read through symlink directories and reports binary and oversized files honestly', async () => {
  const root = await directory(),
    outside = await directory(false);
  await writeFile(join(outside, 'secret'), 'SECRET');
  await mkdir(join(root, 'folder'));
  await writeFile(join(root, 'folder', 'secret'), 'safe');
  await execute('git', ['-C', root, 'add', '.']);
  await writeFile(join(root, 'binary'), Buffer.from([0, 1]));
  await writeFile(join(root, 'large'), 'x'.repeat(200));
  DIFF_LIMITS.fileBytes = 100;
  const turn = await WorkspaceDiff.begin(root);
  await rm(join(root, 'folder'), { recursive: true });
  await symlink(outside, join(root, 'folder'));
  await writeFile(join(root, 'binary'), Buffer.from([0, 2]));
  await writeFile(join(root, 'large'), 'y'.repeat(201));
  const diff = await finish(turn);
  expect(diff.status).toBe('partial');
  expect(JSON.stringify(diff)).not.toContain('SECRET');
  expect(diff.files.find((file) => file.path === 'binary')?.omitted).toContain('二进制');
  expect(diff.files.find((file) => file.path === 'large')?.omitted).toContain('上限');
  expect(diff.files.find((file) => file.path === 'folder/secret')?.omitted).toBeTruthy();
});
it('bounds collected text and displayed patches without hiding omitted modifications', async () => {
  const root = await directory();
  await writeFile(join(root, 'one'), 'before\n');
  await writeFile(join(root, 'two'), 'before\n');
  const turn = await WorkspaceDiff.begin(root);
  await writeFile(join(root, 'one'), 'after\n');
  await writeFile(join(root, 'two'), 'after\n');
  DIFF_LIMITS.resultBytes = 1;
  const diff = await finish(turn);
  expect(diff.status).toBe('partial');
  expect(diff.files).toHaveLength(2);
  expect(
    diff.files.every((file) => file.omitted && !file.before && !file.after && !file.patch),
  ).toBe(true);
});
