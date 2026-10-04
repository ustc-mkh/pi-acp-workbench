import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import {writeAtomicJson} from './atomic-json';
import {snapshotHarness} from './harness';
import { join } from 'node:path';
import type { Snapshot } from './shared';
/** Full local records survive compaction and restart; workspaceState stores small indices only. */
export class SnapshotStore {
  constructor(private directory?: string) {}
  private file(id: string) { return join(this.directory!, createHash('sha256').update(id).digest('hex')+'.json'); }
  async write(snapshot: Snapshot, storageKey = snapshot.id): Promise<Snapshot> {
    if (!this.directory) return snapshot;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeAtomicJson(this.file(storageKey),snapshot);
    const { entries, nativeForks, ...index } = snapshot;
    return {...index,entries:[],stored:true};
  }
  async read(snapshot: Snapshot, storageKey = snapshot.id): Promise<Snapshot> {
    if (!snapshot.stored || !this.directory) return validateSnapshot(structuredClone(snapshot));
    const data = JSON.parse(await readFile(this.file(storageKey),'utf8')) as Snapshot;
    if (data.id!==snapshot.id || data.cwd!==snapshot.cwd || !Array.isArray(data.entries)) throw new Error('本地完整历史文件不匹配，未恢复会话。');
    return validateSnapshot(data);
  }
  async remove(id: string) { if(this.directory) await rm(this.file(id),{force:true}); }
  async clear() { if(this.directory) await rm(this.directory,{force:true,recursive:true}); }
}

/** Current complete snapshots only. Validation never migrates, fills, or rewrites history. */
export function validateSnapshot(snapshot: Snapshot): Snapshot {
  if (!snapshot || typeof snapshot.id!=='string' || typeof snapshot.cwd!=='string' || !Array.isArray(snapshot.entries)
    || snapshot.contextComplete!==true || Object.hasOwn(snapshot,'contextPending')) throw new Error('历史格式不受支持：需要当前完整快照。原文件未修改。');
  snapshotHarness(snapshot);
  return snapshot;
}
