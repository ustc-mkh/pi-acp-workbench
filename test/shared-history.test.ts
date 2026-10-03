import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedHistoryStore, SessionInUseError } from '../src/shared-history';
import type { Snapshot } from '../src/shared';
const directories:string[] = [], stores:SharedHistoryStore[] = [];
async function pair() {
  const root = await mkdtemp(join(tmpdir(),'pi-shared-history-')); directories.push(root);
  const a = new SharedHistoryStore(root), b = new SharedHistoryStore(root); stores.push(a,b); return {a,b};
}
const snapshot = (id:string):Snapshot => ({id,cwd:'/project',title:id,updated:Date.now(),contextComplete:true,entries:[{id:'user',role:'user',text:'hello'}]});
afterEach(async()=>{for(const store of stores.splice(0))await store.releaseAll();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
it('shares all histories without losing concurrent additions or pruning to 20', async()=>{
  const {a,b} = await pair();
  await Promise.all(Array.from({length:24},(_,i)=>(i%2?a:b).import(snapshot(String(i)))));
  expect(await a.list()).toHaveLength(24);
  expect(await b.list()).toHaveLength(24);
  const index = (await b.list())[0];
  expect((await b.read(index)).entries[0]).toMatchObject({text:'hello'});
});
it('requires exclusive session ownership, permits viewing, and transfers ownership after release', async()=>{
  const {a,b} = await pair();
  await a.claim('one'); const index = await a.write(snapshot('one'));
  await expect(b.claim('one')).rejects.toBeInstanceOf(SessionInUseError);
  expect((await b.read(index)).entries).toHaveLength(1);
  await expect(b.write(snapshot('one'))).rejects.toThrow('锁');
  await a.release('one'); await b.claim('one');
  await b.write({...await b.read(index),title:'changed'});
  expect((await a.list())[0].title).toBe('changed');
});
it('prevents deletion/clear from being undone by an old writer or a second migration', async()=>{
  const {a,b} = await pair(); await a.claim('one'); await a.write(snapshot('one'));
  await b.remove('one');
  await expect(a.write(snapshot('one'))).rejects.toThrow('已从共享历史删除');
  await b.import(snapshot('one')); expect(await b.list()).toEqual([]);
  await b.import(snapshot('two')); await a.clear(); await b.import(snapshot('two'));
  expect(await a.list()).toEqual([]);
});
it('keeps the previous full snapshot readable if committing its replacement fails', async()=>{
  const {a,b} = await pair(); await a.claim('one'); const original = await a.write(snapshot('one'));
  vi.spyOn(a as any,'commit').mockRejectedValueOnce(new Error('disk full'));
  await expect(a.write({...snapshot('one'),entries:[{id:'new',role:'user',text:'replacement'}]})).rejects.toThrow('disk full');
  expect((await b.read(original)).entries[0]).toMatchObject({text:'hello'});
});
it('detects stale revisions even after another client releases its lock', async()=>{
  const {a,b} = await pair(); await a.claim('one'); const old = await a.write(snapshot('one'));
  await a.release('one'); await b.claim('one');
  await b.write({...await b.read(old),title:'new'}); await b.release('one');
  await a.claim('one'); await expect(a.write(snapshot('one'))).rejects.toThrow('另一个窗口更新');
  await a.read(old); await expect(a.write(snapshot('one'))).resolves.toMatchObject({id:'one'});
});
