import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  operationRecords,
  imageArchive,
  noticeText,
  archivedEntry,
} from './lib/workbench-sqlite-fixture.mjs';
import { createHash } from 'node:crypto';

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

test('payload fixture checks exact SQL BLOB/hash/identities, is read-only and binds IDs', async () => {
  await fixture(async (root) => {
    const file = join(root, 'workbench.sqlite3');
    const database = new DatabaseSync(file);
    database.exec(
      'PRAGMA user_version=3; CREATE TABLE contents(id TEXT PRIMARY KEY,kind TEXT,sha256 TEXT,bytes INTEGER,data BLOB,image_ref_json TEXT); CREATE TABLE entries(entry_id TEXT PRIMARY KEY,content_id TEXT,metadata_json TEXT)',
    );
    const hash = (data) => createHash('sha256').update(data).digest('hex');
    const pixels = Buffer.from('GIF89a01000100');
    const image = { id: 'image', mime: 'image/gif', bytes: pixels.length, sha256: hash(pixels) };
    const insert = database.prepare('INSERT INTO contents VALUES (?,?,?,?,?,?)');
    insert.run(image.id, 'Image', image.sha256, image.bytes, pixels, JSON.stringify(image));
    const text = '独立 SQL \"fixture\" 🌏';
    const bytes = Buffer.from(text);
    const reference = { id: 'text', kind: 'Text', sha256: hash(bytes), bytes: bytes.length };
    insert.run(reference.id, 'Text', reference.sha256, reference.bytes, bytes, null);
    insert.run(
      `archive-notice-${hash('notice')}`,
      'Text',
      reference.sha256,
      reference.bytes,
      bytes,
      null,
    );
    database
      .prepare('INSERT INTO entries VALUES (?,?,?)')
      .run('entry', 'text', JSON.stringify({ id: 'entry', text: reference, image }));
    database.close();
    const before = await readFile(file);
    assert.deepEqual(imageArchive(root, 'image'), {
      format_version: 1,
      image,
      data: pixels.toString('base64'),
    });
    assert.equal(noticeText(root, 'notice'), text);
    assert.deepEqual(archivedEntry(root, 'entry'), { id: 'entry', text, image });
    assert.throws(() => imageArchive(root, "image' OR 1=1 --"));
    assert.throws(() => archivedEntry(root, "entry' OR 1=1 --"));
    assert.throws(() => noticeText(root, 'missing'));
    assert.deepEqual(await readFile(file), before);
    const corrupt = new DatabaseSync(file);
    corrupt
      .prepare('UPDATE contents SET data=? WHERE id=?')
      .run(Buffer.alloc(pixels.length), image.id);
    corrupt.close();
    assert.throws(() => imageArchive(root, image.id));
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
