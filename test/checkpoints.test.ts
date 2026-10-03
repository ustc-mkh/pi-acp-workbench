import {it,expect,vi} from 'vitest';
import {checkpoint,prepareContext,byteSize,splitBytes} from '../src/checkpoints';
import type {Entry} from '../src/shared';
const entry=(id:string,text:string):Entry=>({id,role:'user',text});
it('reuses a valid compacted prefix and carries the tail without reinflating raw history',async()=>{
  const prefix=[entry('1','原始记录'.repeat(10000))], cp=checkpoint(prefix,'已有压缩摘要','pi','c1');
  const summarize=vi.fn();
  const result=await prepareContext([...prefix,entry('2','新约束')],true,[cp],8000,summarize);
  expect(result.text).toContain('已有压缩摘要');expect(result.text).toContain('新约束');expect(result.text).not.toContain('原始记录');expect(summarize).not.toHaveBeenCalled();
  const again=await prepareContext([...prefix,entry('2','新约束')],true,[result.checkpoint],8000,summarize);
  expect(again.text).toBe(result.text);
});
it('invalidates summaries covering a deleted message and selects only an unchanged older prefix',async()=>{
  const a=entry('a','keep-a'),b=entry('b','deleted-secret'),c=entry('c','keep-c');
  const old=checkpoint([a],'safe-old-summary','pi','old'),newer=checkpoint([a,b,c],'summary contains deleted-secret','pi','new');
  const result=await prepareContext([a,c],true,[old,newer],8000);
  expect(result.reused).toBe(true);expect(result.text).toContain('safe-old-summary');expect(result.text).toContain('keep-c');expect(result.text).not.toContain('deleted-secret');
  const early=await prepareContext([a],true,[newer],8000);expect(early.reused).toBe(false);expect(early.text).toContain('keep-a');
});
it('rebuilds arbitrarily long multibyte history using bounded ordered summary requests',async()=>{
  const calls:string[]=[];const raw=[entry('1','公式🧮中文'.repeat(12000))];
  const result=await prepareContext(raw,true,[],4096,async(text,limit)=>{calls.push(text);expect(byteSize(text)).toBeLessThan(4096);expect(limit).toBe(1024);return '已处理摘要';});
  expect(calls.length).toBeGreaterThan(50);expect(result.summarized).toBe(true);expect(byteSize(result.text)).toBeLessThan(4096);
  const text='🧮中文'.repeat(100);expect(splitBytes(text,19).join('')).toBe(text);expect(splitBytes(text,19).every(s=>byteSize(s)<=19)).toBe(true);
});
it('rejects incomplete local histories and oversized/empty summaries instead of truncating',async()=>{
  const entries=[entry('a','x'.repeat(10000))];
  await expect(prepareContext(entries,false,[],4096,async()=> 'ok')).rejects.toThrow();
  await expect(prepareContext(entries,true,[],4096)).rejects.toThrow('安全输入预算');
  await expect(prepareContext(entries,true,[],4096,async()=> 'x'.repeat(2000))).rejects.toThrow('摘要为空或超过');
  await expect(prepareContext(entries,true,[],4096,async()=> '')).rejects.toThrow('摘要为空或超过');
});
it('cancels between chunks before preparing a replacement checkpoint',async()=>{
  const abort=new AbortController(),fn=vi.fn(async()=>{abort.abort();return 'summary';});
  await expect(prepareContext([entry('a','x'.repeat(10000))],true,[],4096,fn,undefined,abort.signal)).rejects.toThrow();expect(fn).toHaveBeenCalledTimes(1);
});
