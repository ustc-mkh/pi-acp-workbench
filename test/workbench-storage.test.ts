import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const roots: string[] = [];
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'workbench-storage-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});
function run(...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/workbench-storage.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (v) => (stdout += v));
    child.stderr.on('data', (v) => (stderr += v));
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
async function marker(root: string) {
  await writeFile(
    join(root, 'storage-format.json'),
    '{"format_version":2,"storage_kind":"pi-acp-workbench"}\n',
  );
}
it('requires explicit confirmation, refuses active-looking hosts, and exports exact bytes with manifest', async () => {
  const source = await root(),
    destination = `${source}-export`;
  roots.push(destination);
  await marker(source);
  await mkdir(join(source, 'history'), { recursive: true });
  await writeFile(join(source, 'history', 'one.bin'), 'immutable');
  expect(await stat(destination).catch(() => undefined)).toBeUndefined();
  const first = await run('export', '--root', source, '--destination', destination);
  expect(first.code).not.toBe(0);
  await mkdir(join(source, 'history'), { recursive: true });
  await writeFile(join(source, 'workbench.sock'), 'sentinel');
  expect(
    (await run('export', '--root', source, '--destination', destination, '--confirm')).code,
  ).not.toBe(0);
  await rm(join(source, 'workbench.sock'));
  expect(await stat(destination).catch(() => undefined)).toBeUndefined();
  const result = await run('export', '--root', source, '--destination', destination, '--confirm');
  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(destination, 'history', 'one.bin'), 'utf8')).toBe('immutable');
  const manifest = JSON.parse(await readFile(join(destination, 'EXPORT-MANIFEST.json'), 'utf8'));
  expect(manifest.files).toContainEqual(
    expect.objectContaining({ path: 'history/one.bin', bytes: 9 }),
  );
  expect(await stat(join(source, 'history', 'one.bin'))).toBeTruthy();
});
it('reset refuses data and only removes the marker while preserving the stable lease inode', async () => {
  const source = await root();
  await marker(source);
  await writeFile(join(source, 'data'), 'not empty');
  expect((await run('reset', '--root', source, '--confirm')).code).not.toBe(0);
  expect(await stat(source)).toBeTruthy();
  await rm(join(source, 'data'));
  const result = await run('reset', '--root', source, '--confirm');
  expect(result.code).toBe(0);
  await expect(stat(join(source, 'storage-format.json'))).rejects.toThrow();
  expect(await stat(join(source, '.workbench.lock'))).toBeTruthy();
  expect(await stat(source)).toBeTruthy();
});
it('GC leaves archives, journal results and outbox tombstones untouched; corrupt Telegram state fails closed', async () => {
  const source = await root();
  await marker(source);
  for (const directory of ['payloads', 'journal/results', 'outbox', 'telegram'])
    await mkdir(join(source, directory), { recursive: true });
  const retained = ['payloads/image-orphan.json', 'journal/results/old.json', 'outbox/ack.json'];
  for (const file of retained) await writeFile(join(source, file), 'retained');
  expect((await run('gc', '--root', source)).code).not.toBe(0);
  const result = await run('gc', '--root', source, '--confirm');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ removed_inbox: 0, removed_callbacks: 0 });
  await writeFile(join(source, 'telegram/state.json'), '{broken');
  expect((await run('gc', '--root', source, '--confirm')).code).not.toBe(0);
  expect(await readFile(join(source, 'telegram/state.json'), 'utf8')).toBe('{broken');
  for (const file of retained) expect(await readFile(join(source, file), 'utf8')).toBe('retained');
});
it('uses the actual host flock, tolerates an unlocked persistent marker, and never unlinks the lease', async () => {
  const source = await root(),
    destination = `${source}-export`;
  roots.push(destination);
  await marker(source);
  const lock = join(source, '.workbench.lock');
  const holder = spawn('flock', ['-x', lock, 'sh', '-c', 'printf ready; read line'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await once(holder.stdout, 'data');
    const inode = (await stat(lock)).ino;
    for (const command of ['export', 'reset', 'gc']) {
      const args = command === 'export' ? ['--destination', destination] : [];
      expect((await run(command, '--root', source, ...args, '--confirm')).code).not.toBe(0);
    }
    expect((await stat(lock)).ino).toBe(inode);
    const exited = once(holder, 'exit');
    holder.stdin.end('\n');
    await exited;
    const result = await run('export', '--root', source, '--destination', destination, '--confirm');
    expect(result.code, result.stderr).toBe(0);
    expect((await stat(lock)).ino).toBe(inode);
    await expect(stat(join(destination, '.workbench.lock'))).rejects.toThrow();
  } finally {
    holder.kill('SIGKILL');
  }
});
it('rejects symlinks and special files before copying or deleting, and checks canonical destination overlap', async () => {
  const source = await root(),
    destination = `${source}-export`;
  roots.push(destination);
  await marker(source);
  await symlink('/does-not-exist', join(source, 'dangling'));
  for (const command of ['export', 'reset', 'gc']) {
    const args = command === 'export' ? ['--destination', destination] : [];
    expect((await run(command, '--root', source, ...args, '--confirm')).code).not.toBe(0);
  }
  await expect(stat(destination)).rejects.toThrow();
  await rm(join(source, 'dangling'));
  const alias = `${source}-alias`;
  roots.push(alias);
  await symlink(source, alias);
  expect(
    (await run('export', '--root', source, '--destination', join(alias, 'nested'), '--confirm'))
      .code,
  ).not.toBe(0);
});
it('rejects unversioned roots and overlapping/export overwrite destinations', async () => {
  const source = await root(),
    destination = join(source, 'nested');
  expect(
    (await run('export', '--root', source, '--destination', destination, '--confirm')).code,
  ).not.toBe(0);
  await marker(source);
  await mkdir(destination);
  expect(
    (await run('export', '--root', source, '--destination', destination, '--confirm')).code,
  ).not.toBe(0);
});
