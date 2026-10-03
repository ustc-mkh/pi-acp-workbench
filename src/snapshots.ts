import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from './shared';
/** Full local records survive compaction and restart; workspaceState stores small indices only. */
export class SnapshotStore {
  constructor(private directory?: string) {}
  private file(id: string) { return join(this.directory!, createHash('sha256').update(id).digest('hex')+'.json'); }
  async write(snapshot: Snapshot): Promise<Snapshot> {
    if (!this.directory) return snapshot;
    await mkdir(this.directory,{recursive:true});
    const filename=this.file(snapshot.id), temp=filename+'.'+randomUUID()+'.tmp';
    try {await writeFile(temp,JSON.stringify(snapshot),'utf8'); await rename(temp,filename);}
    finally {await rm(temp,{force:true});}
    const { entries, checkpoints, preparedContext, ...index } = snapshot;
    return {...index,entries:[],stored:true};
  }
  async read(snapshot: Snapshot): Promise<Snapshot> {
    if (!snapshot.stored || !this.directory) return structuredClone(snapshot);
    const data=JSON.parse(await readFile(this.file(snapshot.id),'utf8')) as Snapshot;
    if (data.id!==snapshot.id || data.cwd!==snapshot.cwd || !Array.isArray(data.entries)) throw new Error('本地完整历史文件不匹配，未恢复会话。');
    return data;
  }
  async remove(id: string) { if(this.directory) await rm(this.file(id),{force:true}); }
  async clear() { if(this.directory) await rm(this.directory,{force:true,recursive:true}); }
}
