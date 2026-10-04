import {createHash} from 'node:crypto';
import {mkdir,opendir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {writeAtomicJson} from './atomic-json';
import type {TaskQueue} from './task-queue';

export interface Receipt {
  id:string;
  sessionId:string;
  fingerprint:string;
  status:'running'|'completed'|'interrupted';
  result?:unknown;
  error?:string;
}
const hash=(id:string)=>createHash('sha256').update(id).digest('hex');
const MAX_RECEIPT_BYTES=256*1024;
/** Stable JSON identity: key order is irrelevant; array order and every value are significant. */
export function requestFingerprint(method:string,params:unknown):string {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
  return hash(JSON.stringify(canonical({method,params})));
}
/** Durable command receipts and live deduplication have one owner. Completed receipts stay on disk. */
export class RequestJournal {
  private inFlight=new Map<string,{fingerprint:string;operation:Promise<unknown>}>();
  constructor(private directory:string) {}
  get pendingCount() { return this.inFlight.size; }
  private file(id:string) { return join(this.directory,hash(id)+'.json'); }
  private lastFile(sessionId:string) { return join(this.directory,'session-'+hash(sessionId)+'.json'); }
  private async read(file:string):Promise<Receipt|undefined> {
    try {
      if((await stat(file)).size>MAX_RECEIPT_BYTES)throw new Error('任务收据过大');
      const r=JSON.parse(await readFile(file,'utf8')) as Receipt;
      if(!r||typeof r.id!=='string'||typeof r.sessionId!=='string'||!['running','completed','interrupted'].includes(r.status)
        ||typeof r.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(r.fingerprint))throw new Error('任务收据格式不受支持或已损坏，拒绝执行；请保留原文件检查。');
      return r;
    } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error; }
  }
  async get(id:string) {
    const r=await this.read(this.file(id));
    if(r&&r.id!==id)throw new Error('任务收据 ID 不匹配');
    return r;
  }
  async last(sessionId:string) {
    const r=await this.read(this.lastFile(sessionId));
    if(r&&r.sessionId!==sessionId)throw new Error('任务收据会话不匹配');
    return r;
  }
  async write(r:Receipt) {
    if(Buffer.byteLength(JSON.stringify(r))>MAX_RECEIPT_BYTES)throw new Error('任务收据过大');
    await writeAtomicJson(this.file(r.id),r,true);
    if(r.sessionId)await writeAtomicJson(this.lastFile(r.sessionId),r,true);
  }
  async run(id:string,method:string,params:unknown,sessionId:string,queue:TaskQueue,execute:()=>Promise<unknown>,report:(error:unknown)=>void):Promise<unknown> {
    const fingerprint=requestFingerprint(method,params),pending=this.inFlight.get(id);
    if(pending) {
      if(pending.fingerprint!==fingerprint)throw new Error('请求 ID 已被其他操作使用');
      return pending.operation;
    }
    if(this.inFlight.size>=100)throw new Error('服务请求已满');
    const operation=queue.run(sessionId||'create:'+id,async check=>{
      const existing=await this.get(id);
      check();
      if(existing) {
        if(existing.sessionId!==sessionId||existing.fingerprint!==fingerprint)throw new Error('请求 ID 已被其他操作使用');
        if(existing.status!=='completed')throw new Error(existing.error||'此请求曾中断，不会自动重放');
        if(existing.error)throw new Error(existing.error);
        return existing.result;
      }
      const receipt:Receipt={id,sessionId,fingerprint,status:'running'};
      await this.write(receipt);
      try {
        check();
        const result=await execute();
        await this.write({...receipt,status:'completed',result});
        return result;
      } catch(error) {
        await this.write({...receipt,status:'interrupted',error:`请求未完成，不会自动重放：${error instanceof Error?error.message:String(error)}`}).catch(report);
        throw error;
      }
    });
    this.inFlight.set(id,{fingerprint,operation});
    try { return await operation; } finally { this.inFlight.delete(id); }
  }
  async drain() { await Promise.allSettled([...this.inFlight.values()].map(p=>p.operation)); }
  async initialize(recover:(r:Receipt)=>Promise<void>) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    for await(const entry of await opendir(this.directory)) {
      if(!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;
      const file=join(this.directory,entry.name),r=await this.read(file);
      if(!r)continue;
      if(this.file(r.id)!==file)throw new Error('任务收据 ID 不匹配');
      if(r.status!=='running')continue;
      const interrupted:Receipt={...r,status:'interrupted',error:'服务曾中断，此任务不会自动重放。请检查历史和工作区后继续。'};
      const last=await this.last(r.sessionId);
      await recover(interrupted);
      await writeAtomicJson(file,interrupted,true);
      if(r.sessionId&&(!last||last.id===r.id))await writeAtomicJson(this.lastFile(r.sessionId),interrupted,true);
    }
  }
}
