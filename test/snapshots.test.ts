import {it,expect} from 'vitest';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SnapshotStore} from '../src/snapshots';
import {checkpoint} from '../src/checkpoints';
import type {Snapshot} from '../src/shared';
it('persists a complete multi-megabyte transcript and pending checkpoints across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-snapshots-'));
 try{const store=new SnapshotStore(dir);const snapshot:Snapshot={id:'../../arbitrary-id',cwd:'/project',title:'large',updated:1,entries:[{id:'1',role:'user',text:'中文'.repeat(500000)}],contextComplete:true,contextPending:true,conversationId:'logical'};
 snapshot.checkpoints=[checkpoint(snapshot.entries,'small summary','rebuilt','c')];
 const index=await store.write(snapshot);expect(index.entries).toEqual([]);expect(index.checkpoints).toBeUndefined();expect(index.stored).toBe(true);
 expect(await new SnapshotStore(dir).read(index)).toEqual(snapshot);expect(await readdir(dir)).toHaveLength(1);
 await writeFile(join(dir,(await readdir(dir))[0]),JSON.stringify({...snapshot,preparedContext:'legacy duplicate'}));expect(await store.read(index)).toEqual(snapshot);
 await writeFile(join(dir,(await readdir(dir))[0]),JSON.stringify({...snapshot,id:'wrong'}));await expect(store.read(index)).rejects.toThrow('不匹配');
 await store.remove(snapshot.id);expect(await readdir(dir)).toEqual([]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
