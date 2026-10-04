import {createHash} from 'node:crypto';
import {mkdir,opendir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {writeTelegramJson} from './telegram-events';
export interface Receipt {id:string;sessionId:string;status:'running'|'completed'|'interrupted';result?:unknown;error?:string}
const hash=(id:string)=>createHash('sha256').update(id).digest('hex');
const MAX_RECEIPT_BYTES=256*1024;
/** Receipts stay on disk indefinitely for deduplication, never in an unbounded process cache. */
export class RequestJournal {
  constructor(private directory:string){}
  private file(id:string){return join(this.directory,hash(id)+'.json');}
  private lastFile(sessionId:string){return join(this.directory,'session-'+hash(sessionId)+'.json');}
  private async read(file:string):Promise<Receipt|undefined>{
    try{
      if((await stat(file)).size>MAX_RECEIPT_BYTES)throw new Error('任务收据过大');
      const r=JSON.parse(await readFile(file,'utf8')) as Receipt;
      if(!r||typeof r.id!=='string'||typeof r.sessionId!=='string'||!['running','completed','interrupted'].includes(r.status))throw new Error('任务收据损坏，拒绝重放');
      return r;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  async get(id:string){const r=await this.read(this.file(id));if(r&&r.id!==id)throw new Error('任务收据 ID 不匹配');return r;}
  async last(sessionId:string){const r=await this.read(this.lastFile(sessionId));if(r&&r.sessionId!==sessionId)throw new Error('任务收据会话不匹配');return r;}
  async write(r:Receipt){
    if(Buffer.byteLength(JSON.stringify(r))>MAX_RECEIPT_BYTES)throw new Error('任务收据过大');
    await writeTelegramJson(this.file(r.id),r);
    await writeTelegramJson(this.lastFile(r.sessionId),r);
  }
  async initialize(recover:(r:Receipt)=>Promise<void>){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    // Stream the directory: years of completed requests must not fill memory on restart.
    for await(const entry of await opendir(this.directory)){
      if(!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;
      const r=await this.read(join(this.directory,entry.name));if(!r)continue;
      if(this.file(r.id)!==join(this.directory,entry.name))throw new Error('任务收据 ID 不匹配');
      if(r.status!=='running')continue;
      const interrupted:Receipt={...r,status:'interrupted',error:'服务曾中断，此任务不会自动重放。请检查历史和工作区后继续。'};
      const last=await this.last(r.sessionId);
      await recover(interrupted);
      await writeTelegramJson(this.file(r.id),interrupted);
      if(!last||last.id===r.id)await writeTelegramJson(this.lastFile(r.sessionId),interrupted);
    }
  }
}
