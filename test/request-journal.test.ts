import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RequestJournal} from '../src/request-journal';
import {TaskQueue} from '../src/task-queue';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'pi-journal-'));roots.push(root);const journal=new RequestJournal(root);await journal.initialize(async()=>{});return {root,journal,queue:new TaskQueue(1)};}
it('shares an identical in-flight command and persists its result without retaining the promise',async()=>{
 const {root,journal,queue}=await fixture();let release!:()=>void;
 const execute=vi.fn(()=>new Promise(resolve=>{release=()=>resolve({created:'one'});}));
 const params={cwd:'/work',nested:{a:1,b:2}};
 const first=journal.run('id','create',params,'',queue,execute,()=>{});
 await vi.waitFor(()=>expect(execute).toHaveBeenCalledOnce());
 const duplicate=journal.run('id','create',{nested:{b:2,a:1},cwd:'/work'},'',queue,execute,()=>{});
 await expect(journal.run('id','create',{cwd:'/other'},'',queue,execute,()=>{})).rejects.toThrow('请求 ID');
 release();expect(await first).toEqual({created:'one'});expect(await duplicate).toEqual({created:'one'});
 expect(journal.pendingCount).toBe(0);
 const restarted=new RequestJournal(root);await restarted.initialize(async()=>{});
 expect(await restarted.run('id','create',params,'',queue,execute,()=>{})).toEqual({created:'one'});expect(execute).toHaveBeenCalledOnce();await queue.close();
});
it('rejects receipts lacking the current required identity without migrating or deleting them',async()=>{
 const {root,journal,queue}=await fixture(),id='unsupported';
 const file=join(root,createHash('sha256').update(id).digest('hex')+'.json');
 const content=JSON.stringify({id,sessionId:'one',status:'completed',result:'old result'});await writeFile(file,content);
 await expect(journal.get(id)).rejects.toThrow('格式不受支持');expect(await readFile(file,'utf8')).toBe(content);await queue.close();
});
it('checks cancellation after durable writes before invoking the side effect',async()=>{
 const {journal,queue}=await fixture();let release!:()=>void;
 const write=journal.write.bind(journal);
 vi.spyOn(journal,'write').mockImplementationOnce(async receipt=>{await write(receipt);await new Promise<void>(r=>{release=r;});});
 const execute=vi.fn(async()=>({ok:true}));
 const task=journal.run('one','prompt',{sessionId:'s'},'s',queue,execute,()=>{}).catch(error=>error.message);
 await vi.waitFor(()=>expect(release).toBeDefined());queue.cancel('s');release();
 expect(await task).toContain('取消');expect(execute).not.toHaveBeenCalled();expect((await journal.get('one'))?.status).toBe('interrupted');
 expect(await journal.run('two','prompt',{sessionId:'s'},'s',queue,execute,()=>{})).toEqual({ok:true});await queue.close();
});
