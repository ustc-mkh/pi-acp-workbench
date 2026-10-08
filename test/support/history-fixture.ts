// Offline data-format fixture only. Call before starting a daemon, never concurrently with it.
import { mkdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeAtomicJson } from '../../src/atomic-json';
import type { Snapshot } from '../../src/shared';
export class SharedHistoryStore {
  constructor(readonly root: string) {}
  async claim(_id: string) {}
  async release(_id: string) {}
  async releaseAll() {}
  private file(s: Snapshot) {
    return join(
      this.root,
      'conversations',
      createHash('sha256').update(`${s.id}:${s.revision}`).digest('hex') + '.json',
    );
  }
  async list(): Promise<Snapshot[]> {
    try {
      return JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')).sessions;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  async write(snapshot: Snapshot): Promise<Snapshot> {
    await mkdir(join(this.root, 'conversations'), { recursive: true });
    const items = await this.list();
    const version = {
      ...snapshot,
      revision: randomUUID(),
      sessionNumber: snapshot.sessionNumber ?? items.length + 1,
    };
    await writeAtomicJson(this.file(version), version);
    const { nativeForks, ...stub } = version;
    const index = { ...stub, entries: [], stored: true };
    await writeAtomicJson(join(this.root, 'index.json'), {
      sessions: [index, ...items.filter((s) => s.id !== snapshot.id)],
      deleted: [],
      nextSessionNumber: items.length + 2,
    });
    return index;
  }
  async read(snapshot: Snapshot): Promise<Snapshot> {
    return snapshot.stored
      ? JSON.parse(await readFile(this.file(snapshot), 'utf8'))
      : structuredClone(snapshot);
  }
}
