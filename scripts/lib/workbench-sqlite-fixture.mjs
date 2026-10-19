// Independent read-only SQLite assertions for isolated binary-contract fixtures.
// Never imported by production code; no compatibility reader or diagnostic IPC.
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

/** Stopped daemon roots may contain only the lease, marker and SQLite files. */
export function assertStorageLayout(root) {
  const required = ['.workbench.lock', 'storage-format.json', 'workbench.sqlite3'];
  const allowed = new Set([
    ...required,
    'workbench.sqlite3-wal',
    'workbench.sqlite3-shm',
    'workbench.sqlite3-journal',
  ]);
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries)
    assert(entry.isFile() && allowed.has(entry.name), `unexpected storage entry: ${entry.name}`);
  for (const name of required)
    assert(
      entries.some((entry) => entry.name === name),
      `missing storage entry: ${name}`,
    );
}

export function operationRecords(root, operation) {
  const database = new DatabaseSync(join(root, 'workbench.sqlite3'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=5000');
    if (database.prepare('PRAGMA user_version').get().user_version !== 3)
      throw new Error('fixture requires a format3 database');
    const select = 'SELECT operation,fingerprint,status,result,checksum FROM operations';
    const rows =
      operation === undefined
        ? database.prepare(`${select} ORDER BY operation`).all()
        : database.prepare(`${select} WHERE operation=? ORDER BY operation`).all(operation);
    return rows.map((row) => ({
      ...row,
      result: row.result === null ? null : Buffer.from(row.result),
    }));
  } finally {
    database.close();
  }
}

function inspect(root, read) {
  const database = new DatabaseSync(join(root, 'workbench.sqlite3'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout=5000');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 3);
    return read(database);
  } finally {
    database.close();
  }
}
function content(database, id) {
  const row = database
    .prepare('SELECT kind,sha256,bytes,data,image_ref_json FROM contents WHERE id=?')
    .get(id);
  assert(row, `missing archive content ${id}`);
  row.data = Buffer.from(row.data);
  assert.equal(row.data.length, row.bytes);
  assert.equal(createHash('sha256').update(row.data).digest('hex'), row.sha256);
  return row;
}
export function imageArchive(root, id) {
  return inspect(root, (database) => {
    const row = content(database, id);
    assert.equal(row.kind, 'Image');
    const image = JSON.parse(row.image_ref_json);
    assert.equal(image.id, id);
    assert.equal(image.sha256, row.sha256);
    assert.equal(image.bytes, row.bytes);
    return { format_version: 1, image, data: row.data.toString('base64') };
  });
}
export function noticeText(root, id) {
  return inspect(root, (database) => {
    const key = `archive-notice-${createHash('sha256').update(id).digest('hex')}`;
    const row = content(database, key);
    assert.equal(row.kind, 'Text');
    return new TextDecoder('utf-8', { fatal: true }).decode(row.data);
  });
}
export function contentText(root, reference) {
  return inspect(root, (database) => {
    const row = content(database, reference.id);
    assert.equal(row.kind, 'Text');
    assert.equal(reference.kind, 'Text');
    assert.equal(row.sha256, reference.sha256);
    assert.equal(row.bytes, reference.bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(row.data);
  });
}
export function sessionRecord(root, id) {
  return inspect(root, (database) => {
    const row = database
      .prepare(
        'SELECT id,created_seq,revision,last_entry_seq,harness,cwd,status_json,hot_state_json FROM sessions WHERE id=?',
      )
      .get(id);
    assert.ok(row, `missing SQL session ${id}`);
    return { ...row };
  });
}
export function deliveryRecords(root) {
  return inspect(root, (database) =>
    database
      .prepare(
        'SELECT delivery_id,order_seq,revision,target_key,target_json,payload_json,status,attempt,next_retry,last_failure FROM deliveries ORDER BY order_seq',
      )
      .all()
      .map((row) => ({
        event: {
          id: row.delivery_id,
          revision: row.revision,
          target: JSON.parse(row.target_json),
          payload: JSON.parse(row.payload_json),
        },
        target_key: row.target_key,
        sequence: row.order_seq,
        status: row.status,
        attempt: row.attempt,
        retry_at: row.next_retry,
        last_failure: row.last_failure,
      })),
  );
}
export function deliveryEntryIds(root, delivery) {
  return inspect(root, (database) =>
    database
      .prepare('SELECT entry_id FROM delivery_entries WHERE delivery_id=? ORDER BY seq')
      .all(delivery)
      .map((row) => row.entry_id),
  );
}
export function archivedEntry(root, id) {
  return inspect(root, (database) => {
    const row = database
      .prepare('SELECT metadata_json,content_id FROM entries WHERE entry_id=?')
      .get(id);
    assert(row, `missing archive entry ${id}`);
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.id, id);
    assert.equal(metadata.text.id, row.content_id);
    const body = content(database, row.content_id);
    assert.equal(body.kind, 'Text');
    assert.equal(metadata.text.sha256, body.sha256);
    assert.equal(metadata.text.bytes, body.bytes);
    return { ...metadata, text: new TextDecoder('utf-8', { fatal: true }).decode(body.data) };
  });
}
