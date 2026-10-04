import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, readFile, opendir, stat } from 'node:fs/promises';
import {writeAtomicJson} from './atomic-json';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatState } from './shared';

export const telegramDirectory = () => join(homedir(),'.pi','pi-acp-workbench','telegram');
export interface TelegramTurnEvent {
  id:string;sessionId:string;cwd:string;title:string;sessionNumber?:number;
  inputText?:string;text:string;status:'running'|'completed'|'cancelled'|'failed';error?:string;updated:number;
}
export class TelegramEvents {
  constructor(readonly directory=join(telegramDirectory(),'events')) {}
  private file(id:string) {return join(this.directory,createHash('sha256').update(id).digest('hex')+'.json');}
  async write(event:TelegramTurnEvent) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeAtomicJson(this.file(event.id),event,event.status!=='running');
  }
  async remove(id:string) {await rm(this.file(id),{force:true});}
  async *iterate():AsyncGenerator<TelegramTurnEvent> {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    for await(const entry of await opendir(this.directory)) {
      const name=entry.name;if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const file=join(this.directory,name);
      try {
        const info=await stat(file);
        // Abandoned notifications must not accumulate forever if the relay is disabled.
        if(Date.now()-info.mtimeMs>7*86400000){await rm(file,{force:true});continue;}
        if(info.size>16*1024*1024)continue;
        const event=JSON.parse(await readFile(file,'utf8')) as TelegramTurnEvent;
        if(!event||typeof event!=='object'||Array.isArray(event))continue;
        if(event.inputText!==undefined&&typeof event.inputText!=='string')continue;
        if(event.error!==undefined&&typeof event.error!=='string')continue;
        if(typeof event.id!=='string'||typeof event.sessionId!=='string'||typeof event.cwd!=='string'||typeof event.text!=='string'||typeof event.title!=='string'||!['running','completed','cancelled','failed'].includes(event.status)||!Number.isFinite(event.updated)||this.file(event.id)!==file)continue;
        yield event;
      } catch(error) {if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
  /** Convenience for small callers/tests; the daemon consumes iterate() one file at a time. */
  async list(){
    const events:TelegramTurnEvent[]=[];for await(const event of this.iterate())events.push(event);
    return events.sort((a,b)=>a.updated-b.updated);
  }
}

/** Service-owned durable turn publisher; slow storage retains only the latest pending state. */
export class DesktopTelegramTurn {
  private timer?:ReturnType<typeof setTimeout>;
  private writing?:Promise<void>;
  private pendingEvent?:TelegramTurnEvent;
  private event:TelegramTurnEvent;
  private ended=false;
  private cancelled=false;
  constructor(private events:TelegramEvents, private state:ChatState, cwd:string, private start:number,
    private report:(error:unknown)=>void, id:string=randomUUID(), source:'desktop'|'telegram'='desktop') {
    const first=state.entries.find(e=>e.role==='user');
    this.event={id,sessionId:state.sessionId!,cwd,title:first&&'text' in first?first.text.slice(0,70)||'Pi 任务':'Pi 任务',
      sessionNumber:state.sessionNumber,text:'',status:'running',updated:Date.now()};
    const input=state.entries[start-1];
    if(source==='desktop'&&input?.role==='user'){
      const attachments=input.contextBlocks?.filter(b=>b.type!=='text').length||0;
      this.event.inputText=input.text+(attachments?`\n[附带 ${attachments} 个非文本内容，请在 VS Code 查看]`:'');
    }
    this.publish();
  }
  private publish() {
    this.pendingEvent={...this.event};
    if(!this.writing){
      this.writing=(async()=>{
        let failure:unknown;
        while(this.pendingEvent){
          const event=this.pendingEvent;this.pendingEvent=undefined;
          try{await this.events.write(event);failure=undefined;}catch(error){failure=error;this.report(error);}
        }
        if(failure)throw failure;
      })().finally(()=>{this.writing=undefined;if(this.pendingEvent)void this.publish();});
      void this.writing.catch(()=>{});
    }
    return this.writing;
  }
  private capture(){
    this.event.text=this.state.entries.slice(this.start).filter(e=>e.role==='assistant'||e.role==='diff').map(e=>'text' in e?e.text:'').join('\n\n');
    if(this.state.permissions.length)this.event.text+='\n🔐 等待工具授权，可在 VS Code 或 Telegram /status 中处理。';
    this.event.updated=Date.now();
  }
  update() {
    if(this.ended||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;this.capture();void this.publish();},2500);this.timer.unref();
  }
  cancel() {this.cancelled=true;}
  async discard() {
    this.ended=true;if(this.timer)clearTimeout(this.timer);
    await this.writing;await this.events.remove(this.event.id);
  }
  async finish(error?:string,stopReason?:string) {
    if(this.ended)return;
    this.capture();this.ended=true;if(this.timer)clearTimeout(this.timer);
    this.event.status=error?'failed':this.cancelled||stopReason==='cancelled'?'cancelled':stopReason&&stopReason!=='end_turn'?'failed':'completed';
    this.event.error=error;await this.publish();while(this.writing)await this.writing;
  }
}
