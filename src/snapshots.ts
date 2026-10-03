import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from './shared';
/** Full local records survive compaction and restart; workspaceState stores small indices only. */
export class SnapshotStore {
  constructor(private directory?: string) {}
  private file(id: string) { return join(this.directory!, createHash('sha256').update(id).digest('hex')+'.json'); }
  async write(snapshot: Snapshot, storageKey = snapshot.id): Promise<Snapshot> {
    if (!this.directory) return snapshot;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const filename=this.file(storageKey), temp=filename+'.'+randomUUID()+'.tmp';
    try {await writeFile(temp,JSON.stringify(snapshot),{encoding:'utf8',mode:0o600}); await rename(temp,filename);}
    finally {await rm(temp,{force:true});}
    const { entries, checkpoints, nativeForks, ...index } = snapshot;
    return {...index,entries:[],stored:true};
  }
  async read(snapshot: Snapshot, storageKey = snapshot.id): Promise<Snapshot> {
    if (!snapshot.stored || !this.directory) return structuredClone(snapshot);
    // Legacy snapshots duplicated checkpoint text here; it is no longer a source of truth.
    const { preparedContext: _legacy, ...data } = JSON.parse(await readFile(this.file(storageKey),'utf8')) as Snapshot & {preparedContext?: string};
    if (data.id!==snapshot.id || data.cwd!==snapshot.cwd || !Array.isArray(data.entries)) throw new Error('本地完整历史文件不匹配，未恢复会话。');
    return data;
  }
  async remove(id: string) { if(this.directory) await rm(this.file(id),{force:true}); }
  async clear() { if(this.directory) await rm(this.directory,{force:true,recursive:true}); }
}
