import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatState } from './shared';

export const telegramDirectory = () => join(homedir(),'.pi','pi-acp-workbench','telegram');
export interface TelegramTurnEvent {
  id:string;sessionId:string;cwd:string;title:string;sessionNumber?:number;
  text:string;status:'running'|'completed'|'cancelled'|'failed';error?:string;updated:number;
}
export async function writeTelegramJson(file:string,data:unknown) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try {await writeFile(temp,JSON.stringify(data),{mode:0o600});await rename(temp,file);}
  finally {await rm(temp,{force:true});}
}
export class TelegramEvents {
  constructor(readonly directory=join(telegramDirectory(),'events')) {}
  private file(id:string) {return join(this.directory,createHash('sha256').update(id).digest('hex')+'.json');}
  async write(event:TelegramTurnEvent) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeTelegramJson(this.file(event.id),event);
  }
  async remove(id:string) {await rm(this.file(id),{force:true});}
  async list():Promise<TelegramTurnEvent[]> {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const events:TelegramTurnEvent[]=[];
    for(const name of (await readdir(this.directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
      const file=join(this.directory,name);
      try {
        const info=await stat(file);
        // Abandoned notifications must not accumulate forever if the relay is disabled.
        if(Date.now()-info.mtimeMs>7*86400000){await rm(file,{force:true});continue;}
        if(info.size>16*1024*1024)continue;
        const event=JSON.parse(await readFile(file,'utf8')) as TelegramTurnEvent;
        if(typeof event.id!=='string'||typeof event.sessionId!=='string'||typeof event.cwd!=='string'||typeof event.text!=='string'||typeof event.title!=='string'||!['running','completed','cancelled','failed'].includes(event.status)||!Number.isFinite(event.updated)||this.file(event.id)!==file)continue;
        events.push(event);
      } catch(error) {if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return events.sort((a,b)=>a.updated-b.updated);
  }
}

/** Optional VS Code publisher. No bot token or Telegram network access in the extension. */
export class DesktopTelegramTurn {
  private timer?:ReturnType<typeof setTimeout>;
  private pending:Promise<void>=Promise.resolve();
  private event:TelegramTurnEvent;
  private ended=false;
  private cancelled=false;
  constructor(private events:TelegramEvents, private state:ChatState, cwd:string, private start:number,
    private report:(error:unknown)=>void) {
    const first=state.entries.find(e=>e.role==='user');
    this.event={id:randomUUID(),sessionId:state.sessionId!,cwd,title:first&&'text' in first?first.text.slice(0,70)||'Pi 任务':'Pi 任务',
      sessionNumber:state.sessionNumber,text:'',status:'running',updated:Date.now()};
    this.publish();
  }
  private publish() {
    const event={...this.event};
    this.pending=this.pending.catch(()=>{}).then(()=>this.events.write(event)).catch(this.report);
  }
  update() {
    if(this.ended)return;
    this.event.text=this.state.entries.slice(this.start).filter(e=>e.role==='assistant').map(e=>'text' in e?e.text:'').join('\n\n');
    if(this.state.permissions.length)this.event.text+='\n🔐 等待 VS Code 中的工具授权。';
    this.event.updated=Date.now();
    if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;this.publish();},2500);this.timer.unref();}
  }
  cancel() {this.cancelled=true;}
  async discard() {
    this.ended=true;if(this.timer)clearTimeout(this.timer);
    await this.pending;await this.events.remove(this.event.id);
  }
  async finish(error?:string,stopReason?:string) {
    if(this.ended)return;
    this.update();this.ended=true;if(this.timer)clearTimeout(this.timer);
    this.event.status=this.cancelled||stopReason==='cancelled'?'cancelled':error||stopReason&&stopReason!=='end_turn'?'failed':'completed';
    this.event.error=error;this.publish();await this.pending;
  }
}
