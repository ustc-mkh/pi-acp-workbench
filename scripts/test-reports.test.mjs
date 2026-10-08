import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, symlink, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneTestReports, reportRetention } from './lib/test-reports.mjs';

test('retains recent reports, protects active runs and leaves unrelated files and symlinks alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-test-reports-'));
  try {
    for (const [i, name] of ['run-active', 'run-old', 'run-new', 'unrelated'].entries()) {
      const dir = join(root, name);
      await mkdir(dir);
      if (name === 'run-active') await writeFile(join(dir, '.active'), String(process.pid));
      if (name === 'run-old') await writeFile(join(dir, '.active'), '2147483647');
      await utimes(dir, i + 1, i + 1);
    }
    await symlink(join(root, 'unrelated'), join(root, 'run-link'));
    await pruneTestReports(root, 2);
    assert.deepEqual((await readdir(root)).sort(), [
      'run-active',
      'run-link',
      'run-new',
      'unrelated',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid retention before touching reports', () => {
  assert.equal(reportRetention(), 5);
  for (const value of ['0', '-1', '1.5', 'NaN', ''])
    assert.throws(() => reportRetention(value), /positive integer/);
});
