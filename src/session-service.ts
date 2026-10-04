import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import {AgentProcess,type AgentOptions} from './agent';
import {SharedHistoryStore} from './shared-history';
import {initialState,applyUpdate,nextId} from './state';
import {bindNativeForks} from './native-branch';
import {checkPromptSize} from './context';
import {TelegramEvents,DesktopTelegramTurn} from './telegram-events';
import type {Snapshot,ChatState} from './shared';
import type {Inspection} from './telemetry';
import {RequestJournal,type Receipt} from './request-journal';
export interface ServiceConfig {workspaces:Record<string,string>;command:string;args:string[];env?:Record<string,string>;maxWorkers:number;idleMs:number}
export interface ServiceState {snapshot:Snapshot;busy:boolean;permissions:ChatState['permissions'];commands:ChatState['commands'];error?:string}
interface Runtime {snapshot:Snapshot;state:ChatState;agent?:AgentProcess;busy:boolean;cancelled?:boolean;prompting?:boolean;used:number;replay:boolean;permissions:Map<string,(option?:string)=>void>;publication?:DesktopTelegramTurn;cancelTimer?:NodeJS.Timeout;error?:string}
/** Single writer and process owner. Client lifetime never owns a task's lifetime. */
export class SessionService {
  private runtimes=new Map<string,Runtime>();private tails=new Map<string,Promise<unknown>>();private epochs=new Map<string,number>();
  private journal:RequestJournal;private inFlight=new Map<string,Promise<unknown>>();
  private sweeping=false;private queued=0;private active=0;private waiters:(()=>void)[]=[];private closed=false;private timer:NodeJS.Timeout;
  private allocation:Promise<unknown>=Promise.resolve();
  private store:SharedHistoryStore;private events:TelegramEvents;
  constructor(private root:string,private config:ServiceConfig,private broadcast:(event:unknown)=>void,private report:(error:unknown)=>void,
    private makeAgent:(options:AgentOptions)=>AgentProcess=o=>new AgentProcess(o)){
    this.store=new SharedHistoryStore(join(root,'history'),id=>{const r=this.runtimes.get(id);if(r){r.error='会话锁失效';r.agent?.dispose();}});
    this.events=new TelegramEvents(join(root,'telegram','events'));
    this.journal=new RequestJournal(join(root,'service','requests'));
    this.timer=setInterval(()=>{if(this.sweeping)return;this.sweeping=true;void this.exclusive(async()=>{for(const [id,r]of this.runtimes)if(!r.busy&&Date.now()-r.used>=config.idleMs)await this.evict(id,r);}).catch(report).finally(()=>{this.sweeping=false;});},Math.min(config.idleMs,30000));this.timer.unref();
  }
  async initialize(){
    await this.journal.initialize(async receipt=>{
      const snapshot=(await this.list()).find(s=>s.id===receipt.sessionId);
      if(snapshot)await this.events.write({id:'service:'+receipt.id,sessionId:snapshot.id,cwd:snapshot.cwd,title:snapshot.title,sessionNumber:snapshot.sessionNumber,text:'',status:'failed',error:receipt.error,updated:Date.now()});
    });
  }
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const p=this.allocation.catch(()=>{}).then(fn);this.allocation=p.then(()=>{},()=>{});return p;}
  private async evict(id:string,r:Runtime){r.agent?.dispose();if(r.agent)await new Promise(resolve=>setTimeout(resolve,1600));this.runtimes.delete(id);await this.store.release(id);}
  private async schedule<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    if(this.closed)throw new Error('会话服务正在停止');if(this.queued>=100)throw new Error('服务排队已满');
    this.queued++;const epoch=this.epochs.get(id)||0;
    const p=(this.tails.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if(this.active>=this.config.maxWorkers)await new Promise<void>(resolve=>this.waiters.push(resolve));else this.active++;
      try{if(this.closed||epoch!==(this.epochs.get(id)||0))throw new Error('排队请求已取消');return await fn();}
      finally{const next=this.waiters.shift();if(next)next();else this.active--;}
    });this.tails.set(id,p);try{return await p;}finally{this.queued--;if(this.tails.get(id)===p){this.tails.delete(id);this.epochs.delete(id);}}
  }
  async list(){return (await this.store.list()).filter(s=>s.harness==='pi'&&Object.values(this.config.workspaces).includes(s.cwd));}
  private async index(id:string){const s=(await this.list()).find(s=>s.id===id);if(!s)throw new Error('会话不存在或工作区不在服务允许范围');return s;}
  private view(r:Runtime):ServiceState{return {snapshot:{...r.snapshot,entries:r.state.entries,configs:r.state.configs,modes:r.state.modes,nativeForks:r.state.nativeForks},busy:r.busy,permissions:r.state.permissions,commands:r.state.commands,error:r.error};}
  private emit(r:Runtime){this.broadcast({type:'state',...this.view(r)});}
  private async save(r:Runtime){const first=r.state.entries.find(e=>e.role==='user');const snapshot={...r.snapshot,entries:structuredClone(r.state.entries),configs:r.state.configs,modes:r.state.modes,commands:r.state.commands,nativeForks:r.state.nativeForks,updated:Date.now(),title:first&&'text'in first?first.text.slice(0,70)||'新对话':r.snapshot.title};
    r.snapshot=await this.store.write(snapshot);}
  private async runtime(id:string):Promise<Runtime>{
    return this.exclusive(async()=>{let r=this.runtimes.get(id);if(r){r.busy=true;r.cancelled=false;return r;}
      if(this.runtimes.size>=this.config.maxWorkers){const idle=[...this.runtimes].filter(([,r])=>!r.busy).sort((a,b)=>a[1].used-b[1].used)[0];if(!idle)throw new Error('工作进程均忙碌');await this.evict(...idle);}
      const index=await this.index(id);await this.store.claim(id);
      try{const snapshot=await this.store.read(index);r={snapshot:{...snapshot,entries:[]},state:{...initialState(),sessionId:id,entries:snapshot.entries,configs:snapshot.configs,modes:snapshot.modes,nativeForks:snapshot.nativeForks,commands:snapshot.commands||[]},busy:true,used:Date.now(),replay:false,permissions:new Map()};this.runtimes.set(id,r);return r;}
      catch(error){await this.store.release(id);throw error;}});
  }
  private async worker(r:Runtime){
    if(r.agent&&!r.agent.isClosed)return r.agent;
    r.replay=true;let replay:ChatState|undefined=initialState();
    const agent=this.makeAgent({cwd:r.snapshot.cwd,commandSetting:'sessions.json 的 command/env',command:this.config.command,args:this.config.args,env:{...this.config.env,PI_TELEGRAM_BOT_TOKEN:''},
      log:text=>this.report(text),closed:error=>{r.error=error;this.emit(r);},
      update:n=>{if(n.sessionId!==r.snapshot.id)return;if(r.replay){if(replay)applyUpdate(replay,n.update,true);return;}applyUpdate(r.state,n.update);r.publication?.update();this.broadcast({type:'update',notification:n});},
      permission:request=>new Promise(resolve=>{if(this.closed||r.replay||r.permissions.size>=32||Buffer.byteLength(JSON.stringify(request))>256*1024){resolve({outcome:{outcome:'cancelled'}});return;}
        const id=randomUUID(),timer=setTimeout(()=>settle(),300000);
        const settle=(option?:string)=>{clearTimeout(timer);r.permissions.delete(id);r.state.permissions=r.state.permissions.filter(p=>p.id!==id);resolve({outcome:option?{outcome:'selected',optionId:option}:{outcome:'cancelled'}});this.emit(r);};
        r.permissions.set(id,settle);r.state.permissions.push({id,request});this.emit(r);}),
    });r.agent=agent;
    try{await agent.initialize();const s=await agent.createSession(r.snapshot.id);if(!r.snapshot.contextComplete&&replay.entries.length)r.state.entries=replay.entries;r.snapshot.contextComplete=true;r.state.commands=replay.commands;r.state.configs=s.configOptions||r.state.configs;r.state.modes=s.modes||r.state.modes;r.replay=false;replay=undefined;return agent;}
    catch(error){replay=undefined;agent.dispose();throw error;}
  }
  async state(id:string):Promise<ServiceState>{await this.index(id);const r=this.runtimes.get(id);if(r)return this.view(r);const snapshot=await this.store.read(await this.index(id));return {snapshot,busy:false,permissions:[],commands:snapshot.commands||[],error:(await this.journal.last(id))?.status==='interrupted'?'上次任务被服务中断，未自动重放。':undefined};}
  async handle(method:string,p:any,requestId:string):Promise<unknown>{
    if(method==='hello')return {protocolVersion:1,agentInfo:{name:'pi-session-service',title:'Pi 会话服务',version:'1'},agentCapabilities:{loadSession:true,promptCapabilities:{image:true,embeddedContext:true},_meta:{'pi-workbench':{version:1,inspect:true,nativeFork:true}}}};
    if(method==='list')return this.list();
    if(method==='state')return this.state(p.sessionId);
    if(method==='create')return this.schedule('create:'+requestId,async()=>{
      const cwd=await realpath(p.cwd);if(!Object.values(this.config.workspaces).includes(cwd))throw new Error('工作区不在服务允许范围');
      return this.exclusive(async()=>{
        if(this.runtimes.size>=this.config.maxWorkers){const idle=[...this.runtimes].find(([,r])=>!r.busy);if(!idle)throw new Error('工作进程均忙碌');await this.evict(...idle);}
        const initial=initialState();
        const agent=this.makeAgent({cwd,commandSetting:'sessions.json 的 command/env',command:this.config.command,args:this.config.args,env:{...this.config.env,PI_TELEGRAM_BOT_TOKEN:''},update:n=>applyUpdate(initial,n.update,true),permission:async()=>({outcome:{outcome:'cancelled'}}),closed:()=>{},log:this.report});
        try{await agent.initialize();const s=await agent.createSession();await this.store.claim(s.sessionId);try{return await this.store.write({id:s.sessionId,cwd,harness:'pi',title:'新对话',updated:Date.now(),entries:[],commands:initial.commands,configs:s.configOptions||undefined,modes:s.modes||undefined,contextComplete:true});}finally{await this.store.release(s.sessionId);}}
        finally{agent.dispose();await new Promise(resolve=>setTimeout(resolve,1600));}
      });
    });
    await this.index(p.sessionId);
    if(method==='permission'){const r=this.runtimes.get(p.sessionId),permission=r?.state.permissions.find(x=>x.id===p.permissionId);if(!r||!permission||p.optionId!==undefined&&!permission.request.options.some(o=>o.optionId===p.optionId))return false;r.permissions.get(p.permissionId)?.(p.optionId);return true;}
    if(method==='cancel'){if(this.tails.has(p.sessionId))this.epochs.set(p.sessionId,(this.epochs.get(p.sessionId)||0)+1);const r=this.runtimes.get(p.sessionId);if(!r?.busy)return false;r.cancelled=true;for(const settle of r.permissions.values())settle();const agent=r.agent;clearTimeout(r.cancelTimer);r.cancelTimer=setTimeout(()=>{if(r.busy&&r.agent===agent)agent?.dispose();},5000);r.cancelTimer.unref();if(r.prompting)await agent?.cancel(p.sessionId);return true;}
    if(method==='request'&&p.method==='_pi_workbench/cancel_fork')return this.runtimes.get(p.sessionId)?.agent?.request(p.method,{sessionId:p.sessionId})||{};
    if(method==='remove')return this.schedule(p.sessionId,async()=>{await this.exclusive(async()=>{const r=this.runtimes.get(p.sessionId);if(r)await this.evict(p.sessionId,r);});await this.store.remove(p.sessionId);});
    if(method!=='prompt'&&method!=='request')throw new Error('未知服务操作');
    if(method==='request'&&p.method==='_pi_workbench/inspect'&&!p.params?.force&&!this.runtimes.get(p.sessionId)?.agent)return {records:[],contextWindow:(await this.state(p.sessionId)).snapshot.contextWindow};
    if(method==='request'&&!['_pi_workbench/inspect','_pi_workbench/fork','_pi_workbench/cancel_fork','session/set_mode','session/set_config_option'].includes(p.method))throw new Error('不支持的 ACP 操作');
    if(this.inFlight.has(requestId))return this.inFlight.get(requestId);
    if(this.inFlight.size>=100)throw new Error('服务请求已满');
    // Reserve the ID before the journal read yields, so concurrent duplicates share one execution.
    const operation=(async()=>{
      const existing=await this.journal.get(requestId);
      if(existing){if(existing.sessionId!==p.sessionId)throw new Error('请求 ID 已被使用');if(existing.status!=='completed')throw new Error(existing.error||'此请求曾中断，不会自动重放');if(existing.error)throw new Error(existing.error);return existing.result;}
      return this.schedule(p.sessionId,async()=>{
      const r=await this.runtime(p.sessionId);let checkpoint:NodeJS.Timeout|undefined;let saving=Promise.resolve(),savingBusy=false;
      try{
        const agent=await this.worker(r);r.error=undefined;if(r.cancelled)return {stopReason:'cancelled'};
        if(method==='request'){
          const result:any=await agent.withTimeout(agent.request(p.method,{...p.params,sessionId:p.sessionId}),p.method==='_pi_workbench/fork'?180000:30000);
          if(p.method==='_pi_workbench/inspect'){const inspection=result as Inspection;r.state.nativeForks=bindNativeForks(r.state.entries,inspection.forkPoints||[]);r.snapshot.contextWindow=inspection.contextWindow;}
          if(p.method==='session/set_config_option')r.state.configs=result.configOptions;
          if(p.method==='session/set_mode'&&r.state.modes)r.state.modes.currentModeId=p.params.modeId;
          if(p.method==='_pi_workbench/fork'){
            const index=r.state.entries.findIndex(e=>{const target=r.state.nativeForks?.[e.id];return target?.entryId===p.params.entryId;});if(index<0)throw new Error('原生分支位置无法匹配');
            const snapshot:Snapshot={...r.snapshot,id:result.sessionId,conversationId:result.sessionId,sessionNumber:undefined,revision:undefined,entries:r.state.entries.slice(0,index+1),nativeForks:undefined};
            // Load the fork's own native settings without allocating an extra pool slot.
            agent.dispose();await new Promise(resolve=>setTimeout(resolve,1600));r.agent=undefined;
            const fork=this.makeAgent({cwd:snapshot.cwd,commandSetting:'sessions.json 的 command/env',command:this.config.command,args:this.config.args,env:{...this.config.env,PI_TELEGRAM_BOT_TOKEN:''},update:()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),closed:()=>{},log:this.report});
            try{await fork.initialize();const settings=await fork.createSession(snapshot.id);snapshot.configs=settings.configOptions||undefined;snapshot.modes=settings.modes||undefined;}
            finally{fork.dispose();await new Promise(resolve=>setTimeout(resolve,1600));}
            const first=snapshot.entries.find(e=>e.role==='user');snapshot.title=first&&'text'in first?first.text.slice(0,70):'新分支';
            await this.store.claim(snapshot.id);try{await this.store.write(snapshot);}finally{await this.store.release(snapshot.id);}
          }
          await this.save(r);return result;
        }
        if(p.prompt?.some((b:any)=>b.type==='image')&&!agent.info?.agentCapabilities?.promptCapabilities?.image)throw new Error('当前 Pi 适配器不支持图片');
        if(!Array.isArray(p.prompt)||!p.prompt.length)throw new Error('消息为空');checkPromptSize(p.prompt);
        const receipt:Receipt={id:requestId,sessionId:p.sessionId,status:'running'};await this.journal.write(receipt);
        r.state.entries.push({id:nextId(),role:'user',text:p.prompt.filter((b:acp.ContentBlock)=>b.type==='text').map((b:any)=>b.text).join('\n'),contextBlocks:p.prompt});
        await this.save(r);const start=r.state.entries.length;this.emit(r);
        // The service owns notification delivery even if every client disconnects.
        r.publication=new DesktopTelegramTurn(this.events,r.state,r.snapshot.cwd,start,this.report,'service:'+requestId);
        checkpoint=setInterval(()=>{if(savingBusy)return;savingBusy=true;saving=this.save(r).catch(error=>{r.error=String(error);r.agent?.dispose();this.report(error);}).finally(()=>{savingBusy=false;});},2000);
        let result:acp.PromptResponse;
        try{r.prompting=true;result=r.cancelled?{stopReason:'cancelled'}:await agent.prompt(p.sessionId,p.prompt);if(result.stopReason!=='end_turn')r.state.entries.push({id:nextId(),role:'notice',text:`本轮结束：${result.stopReason}`});}
        catch(error){r.error=r.cancelled?undefined:error instanceof Error?error.message:String(error);r.state.entries.push({id:nextId(),role:'notice',text:r.cancelled?'本轮已停止。':`本轮失败：${r.error}`});result={stopReason:'cancelled'};}
        clearInterval(checkpoint);await saving;await this.save(r);await r.publication.finish(r.error,result.stopReason);r.publication=undefined;
        const completed:Receipt={...receipt,status:'completed',result,error:r.error};await this.journal.write(completed);
        if(r.error)throw new Error(r.error);return result;
      }catch(error){r.error=error instanceof Error?error.message:String(error);if(r.publication){await r.publication.finish(r.error).catch(this.report);r.publication=undefined;}throw error;}finally{r.prompting=false;clearInterval(checkpoint);clearTimeout(r.cancelTimer);await saving;for(const settle of r.permissions.values())settle();r.busy=false;r.used=Date.now();this.emit(r);}
      });
    })();
    this.inFlight.set(requestId,operation);try{return await operation;}finally{this.inFlight.delete(requestId);}
  }
  async dispose(){this.closed=true;clearInterval(this.timer);for(const r of this.runtimes.values()){for(const settle of r.permissions.values())settle();r.agent?.dispose();}await Promise.allSettled([...this.tails.values()]);await this.exclusive(async()=>{for(const [id,r]of this.runtimes)await this.evict(id,r);});await this.store.releaseAll();}
}
