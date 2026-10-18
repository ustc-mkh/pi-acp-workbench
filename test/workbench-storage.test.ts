import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
    '{"format_version":3,"storage_kind":"pi-acp-workbench"}\n',
  );
}
async function databaseFixture(root: string) {
  const database = new DatabaseSync(join(root, 'workbench.sqlite3'));
  try {
    database.exec(
      await readFile('rust/crates/pi-acp-workbenchd/src/persistence/schema.sql', 'utf8'),
    );
  } finally {
    database.close();
  }
  await marker(root);
}
function retainedRows(root: string) {
  const database = new DatabaseSync(join(root, 'workbench.sqlite3'), { readOnly: true });
  try {
    return ['contents', 'entries', 'operations', 'deliveries'].map((table) =>
      database.prepare(`SELECT * FROM ${table}`).all(),
    );
  } finally {
    database.close();
  }
}
it('requires explicit confirmation, refuses active-looking hosts, and exports exact bytes with manifest', async () => {
  const source = await root(),
    destination = `${source}-export`;
  roots.push(destination);
  await databaseFixture(source);
  // Extra operator files are export inputs, not a persistence backend.
  await mkdir(join(source, 'operator-backup'), { recursive: true });
  await writeFile(join(source, 'operator-backup', 'one.bin'), 'immutable');
  expect(await stat(destination).catch(() => undefined)).toBeUndefined();
  const first = await run('export', '--root', source, '--destination', destination);
  expect(first.code).not.toBe(0);
  await writeFile(join(source, 'workbench.sock'), 'sentinel');
  expect(
    (await run('export', '--root', source, '--destination', destination, '--confirm')).code,
  ).not.toBe(0);
  await rm(join(source, 'workbench.sock'));
  expect(await stat(destination).catch(() => undefined)).toBeUndefined();
  const result = await run('export', '--root', source, '--destination', destination, '--confirm');
  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(destination, 'operator-backup', 'one.bin'), 'utf8')).toBe('immutable');
  const manifest = JSON.parse(await readFile(join(destination, 'EXPORT-MANIFEST.json'), 'utf8'));
  expect(manifest.files).toContainEqual(
    expect.objectContaining({ path: 'operator-backup/one.bin', bytes: 9 }),
  );
  expect(manifest.format_version).toBe(3);
  expect(await readFile(join(destination, 'workbench.sqlite3'))).toEqual(
    await readFile(join(source, 'workbench.sqlite3')),
  );
  expect(await stat(join(source, 'operator-backup', 'one.bin'))).toBeTruthy();
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
it('GC preserves SQL archives, raw operation receipts and delivery tombstones; corrupt DB fails closed', async () => {
  const source = await root();
  await databaseFixture(source);
  const database = new DatabaseSync(join(source, 'workbench.sqlite3'));
  const data = Buffer.from('immutable 🌏 archive');
  const hash = createHash('sha256').update(data).digest('hex');
  const reference = { id: 'archive-text', kind: 'Text', sha256: hash, bytes: data.length };
  database
    .prepare('INSERT INTO contents(id,kind,sha256,bytes,data) VALUES (?,?,?,?,?)')
    .run(reference.id, reference.kind, hash, data.length, data);
  const metadata = {
    id: 'archived-entry',
    turn: 'turn',
    role: 'Agent',
    message: null,
    text: reference,
    image: null,
  };
  database
    .prepare('INSERT INTO entries(entry_id,turn,role,content_id,metadata_json) VALUES (?,?,?,?,?)')
    .run(metadata.id, metadata.turn, metadata.role, reference.id, JSON.stringify(metadata));
  const receipt = Buffer.from('{ "Ok": [] }\n');
  database
    .prepare(
      'INSERT INTO operations(operation,fingerprint,status,result,checksum) VALUES (?,?,?,?,?)',
    )
    .run(
      'completed-operation',
      'a'.repeat(64),
      'Completed',
      receipt,
      createHash('sha256').update(receipt).digest('hex'),
    );
  database
    .prepare(
      'INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      'acked-delivery',
      1,
      1,
      'session:removed-session',
      JSON.stringify({ Session: { session: 'removed-session', cwd: '/tmp' } }),
      JSON.stringify({ Notice: { content: reference } }),
      'Acked',
    );
  database.close();
  const retained = retainedRows(source);
  expect((await run('gc', '--root', source)).code).not.toBe(0);
  const result = await run('gc', '--root', source, '--confirm');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ removed_inbox: 0, removed_callbacks: 0 });
  expect(retainedRows(source)).toEqual(retained);
  await writeFile(join(source, 'workbench.sqlite3'), 'not a SQLite database');
  expect((await run('gc', '--root', source, '--confirm')).code).not.toBe(0);
  expect(await readFile(join(source, 'workbench.sqlite3'), 'utf8')).toBe('not a SQLite database');
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
it('refuses frozen format2 roots without creating a DB, changing bytes or exporting them as format3', async () => {
  const source = await root();
  const frozen = await readFile('test/fixtures/formats/workbench-v2/storage-format.json');
  await writeFile(join(source, 'storage-format.json'), frozen);
  const destination = `${source}-export`;
  roots.push(destination);
  for (const command of ['gc', 'reset', 'export']) {
    const extra = command === 'export' ? ['--destination', destination] : [];
    expect((await run(command, '--root', source, ...extra, '--confirm')).code).not.toBe(0);
    expect(await readFile(join(source, 'storage-format.json'))).toEqual(frozen);
    await expect(stat(join(source, 'workbench.sqlite3'))).rejects.toThrow();
    await expect(stat(destination)).rejects.toThrow();
  }
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
