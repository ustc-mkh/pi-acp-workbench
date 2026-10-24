// Test-only stopped-root fixture. No production reader, migration or live writes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function png() {
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (name, data) => {
    const bytes = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const header = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, bytes, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1180, 0);
  header.writeUInt32BE(1180, 4);
  header[8] = 8;
  header[9] = 2; // 8-bit RGB, standard zlib/filter/no interlace
  const pixels = Buffer.alloc(1180 * (1 + 1180 * 3));
  let random = 0x12345678;
  for (let offset = 0; offset < pixels.length; offset++) {
    if (offset % (1 + 1180 * 3) === 0) continue; // PNG filter None
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    pixels[offset] = random & 255;
  }
  const data = deflateSync(pixels, { level: 0 });
  assert(inflateSync(data).equals(pixels));
  const chunks = [
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ];
  const padding = 4 * 1024 * 1024 - chunks.reduce((n, item) => n + item.length, 0) - 12;
  assert(padding >= 0);
  chunks.splice(3, 0, chunk('npAD', Buffer.alloc(padding)));
  const result = Buffer.concat(chunks);
  assert.equal(result.length, 4 * 1024 * 1024);
  return result;
}

export function seedMixedFixture(root, source, duration) {
  assert(
    basename(dirname(root)).startsWith('workbench-host-mixed-'),
    'only an isolated runner root may be seeded',
  );
  assert(
    !existsSync(join(root, 'workbench.sock')),
    'host must have normally shut down before seeding',
  );
  const db = new DatabaseSync(join(root, 'workbench.sqlite3'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const original = db.prepare('SELECT * FROM sessions WHERE id=?').get(source);
    const view = JSON.parse(original.hot_state_json);
    assert.equal(view.status, 'Idle');
    const count = db.prepare('SELECT count(*) AS n FROM sessions').get().n;
    let created = db.prepare("SELECT value FROM store_meta WHERE key='created_seq'").get().value;
    const insertSession = db.prepare(
      'INSERT INTO sessions(id,created_seq,revision,last_entry_seq,harness,cwd,status_json,hot_state_json) VALUES(?,?,0,0,?,?,?,?)',
    );
    const empty = {
      ...view,
      provider_session: null,
      active_turn: null,
      pending_interactions: {},
      configuration_intent: null,
      origin: null,
      revision: 0,
      last_entry_seq: 0,
    };
    for (let index = count; index < 10000; index++) {
      const id = `mixed-cold-${index}`;
      insertSession.run(
        id,
        ++created,
        view.harness,
        view.cwd,
        '"Idle"',
        JSON.stringify({ ...empty, id }),
      );
    }
    db.prepare("UPDATE store_meta SET value=? WHERE key='created_seq'").run(created);
    const put = db.prepare(
      'INSERT INTO contents(id,kind,sha256,bytes,data,image_ref_json) VALUES(?,?,?,?,?,?)',
    );
    // Each historical binary initializes its own new isolated root. No old
    // schema is read by production, and this fixture never migrates a root.
    const hasArchiveRoots = Boolean(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='archive_roots'").get(),
    );
    const putText = (id, text) => {
      const bytes = Buffer.from(text),
        ref = { id, kind: 'Text', sha256: hash(bytes), bytes: bytes.length };
      put.run(id, 'Text', ref.sha256, bytes.length, bytes, null);
      if (hasArchiveRoots) db.prepare("INSERT INTO archive_roots VALUES(?,'text_archive')").run(id);
      return ref;
    };
    const short = putText('mixed-small', '历史 Unicode 🌏');
    const putEntry = db.prepare(
      'INSERT INTO entries(entry_id,turn,role,content_id,metadata_json) VALUES(?,?,?,?,?)',
    );
    const linkEntry = db.prepare('INSERT INTO session_entries VALUES(?,?,?)');
    const start = view.last_entry_seq;
    for (let seq = start + 1; seq <= 100000; seq++) {
      const id = `mixed-old-entry-${seq}`;
      const metadata = {
        id,
        turn: 'mixed-old-turn',
        role: 'Agent',
        message: null,
        text: short,
        image: null,
      };
      putEntry.run(id, metadata.turn, metadata.role, short.id, JSON.stringify(metadata));
      linkEntry.run(source, seq, id);
    }
    db.prepare('UPDATE sessions SET last_entry_seq=100000,hot_state_json=? WHERE id=?').run(
      JSON.stringify({ ...view, last_entry_seq: 100000 }),
      source,
    );
    const content = putText('mixed-body-1m', 'a'.repeat(1024 * 1024));
    const pixels = png(),
      image = {
        id: 'mixed-image-4m',
        mime: 'image/png',
        bytes: pixels.length,
        sha256: hash(pixels),
      };
    put.run(image.id, 'Image', image.sha256, image.bytes, pixels, JSON.stringify(image));
    db.prepare("INSERT INTO telegram_meta VALUES(999,0,'999')").run();
    let sequence = db.prepare("SELECT value FROM store_meta WHERE key='delivery_seq'").get().value;
    const delivery = db.prepare(
      "INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status,next_retry) VALUES(?,?,0,?,?,?,'Pending',?)",
    );
    const insert = (thread, payload, retry) => {
      const target = { Telegram: { bot_id: 999, chat: -100, thread, cwd: view.cwd } };
      delivery.run(
        `mixed-delivery-${++sequence}`,
        sequence,
        `telegram:999:-100:${thread}`,
        JSON.stringify(target),
        JSON.stringify(payload),
        retry,
      );
    };
    for (let thread = 1; thread <= 2048; thread++)
      insert(thread, { Notice: { content: short } }, Number.MAX_SAFE_INTEGER);
    const perLane = Math.ceil((duration * 1000) / 50) + 1000;
    for (let seq = 0; seq < perLane; seq++)
      for (let lane = 0; lane < 8; lane++) {
        const ref = putText(`mixed-ready-${lane}-${seq}`, `ready:${lane}:${seq}`);
        insert(10000 + lane, { Notice: { content: ref } }, 0);
      }
    db.prepare("UPDATE store_meta SET value=? WHERE key='delivery_seq'").run(sequence);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 10000);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM session_entries WHERE session=?').get(source).n,
      100000,
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.exec('COMMIT');
    return {
      content,
      image,
      sessions: 10000,
      entries: 100000,
      deferred_topics: 2048,
      ready_lanes: 8,
      per_lane: perLane,
    };
  } finally {
    db.close();
  }
}
