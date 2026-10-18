import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { operationRecords } from './lib/workbench-sqlite-fixture.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-sqlite-fixture-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('operation fixture reads exact immutable rows and binds the operation filter without modifying DB', async () => {
  await fixture(async (root) => {
    const file = join(root, 'workbench.sqlite3');
    const database = new DatabaseSync(file);
    database.exec(
      'CREATE TABLE operations(operation TEXT PRIMARY KEY,fingerprint TEXT,status TEXT,result BLOB,checksum TEXT); PRAGMA user_version=3',
    );
    const insert = database.prepare('INSERT INTO operations VALUES (?,?,?,?,?)');
    const bytes = Buffer.from('{ "Ok": [] }\n');
    insert.run('z', 'f'.repeat(64), 'Completed', bytes, 'a'.repeat(64));
    insert.run('a', 'e'.repeat(64), 'Started', null, null);
    database.close();
    const before = await readFile(file);
    const rows = operationRecords(root);
    assert.deepEqual(
      rows.map((row) => row.operation),
      ['a', 'z'],
    );
    assert.equal(rows[0].result, null);
    assert.deepEqual(rows[1].result, bytes);
    assert.equal(rows[1].checksum, 'a'.repeat(64));
    assert.deepEqual(operationRecords(root, 'z'), [rows[1]]);
    assert.deepEqual(operationRecords(root, "z' OR 1=1 --"), []);
    assert.deepEqual(await readFile(file), before);
  });
});

test('operation fixture rejects missing and format2 databases without initializing or migrating them', async () => {
  await fixture(async (root) => {
    const file = join(root, 'workbench.sqlite3');
    assert.throws(() => operationRecords(root));
    await assert.rejects(access(file));
    const database = new DatabaseSync(file);
    database.exec('PRAGMA user_version=2');
    database.close();
    const before = await readFile(file);
    assert.throws(() => operationRecords(root), /format3/);
    assert.deepEqual(await readFile(file), before);
  });
});
