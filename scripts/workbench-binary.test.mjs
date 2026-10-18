import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';

const scripts = ['contract', 'telegram-contract', 'process-loss', 'browser-smoke'];

test('binary resolution: absolute, existing executable regular files only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-binary-'));
  try {
    const binary = join(root, 'daemon');
    await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(resolveWorkbenchBinary(binary), binary);
    assert.throws(() => resolveWorkbenchBinary('relative'));
    assert.throws(() => resolveWorkbenchBinary(''));
    assert.throws(() => resolveWorkbenchBinary(join(root, 'missing')));
    assert.throws(() => resolveWorkbenchBinary(root));
    await chmod(binary, 0o600);
    assert.throws(() => resolveWorkbenchBinary(binary));
    const debug = join(root, 'rust/target/debug/pi-acp-workbenchd');
    await mkdir(join(root, 'rust/target/debug'), { recursive: true });
    const runDefault = () =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {resolveWorkbenchBinary} from ${JSON.stringify(new URL('./lib/workbench-binary.mjs', import.meta.url).href)}; console.log(resolveWorkbenchBinary());`,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    const missing = runDefault();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
    await writeFile(debug, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const found = runDefault();
    assert.ifError(found.error);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout.trim(), debug);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const script of scripts)
  test(`${script}: invalid explicit binary never spawns debug fallback`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-no-fallback-'));
    try {
      const debug = join(root, 'rust/target/debug');
      await mkdir(debug, { recursive: true });
      await writeFile(
        join(debug, 'pi-acp-workbenchd'),
        '#!/bin/sh\ntouch debug-was-run\nexit 99\n',
        { mode: 0o700 },
      );
      const denied = join(root, 'denied');
      await writeFile(denied, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      for (const bad of ['relative', join(root, 'missing'), denied, root]) {
        const child = spawnSync(
          process.execPath,
          [resolve(`scripts/workbench-${script}.mjs`), '--binary', bad],
          { cwd: root, encoding: 'utf8', timeout: 10000 },
        );
        assert.ifError(child.error);
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /absolute path|ENOENT|EACCES|regular file/);
        await assert.rejects(readFile(join(root, 'debug-was-run')), { code: 'ENOENT' });
      }
      // All host spawns must use the checked result, not a second resolution.
      const source = await readFile(resolve(`scripts/workbench-${script}.mjs`), 'utf8');
      assert.match(source, /spawn\(binary,/);
      assert(!source.includes("resolve('rust/target/debug/pi-acp-workbenchd')"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
