import { randomUUID } from 'node:crypto';
import { AgentProcess, type AgentOptions } from './agent';
import { SharedHistoryStore } from './shared-history';
import { initialState, applyUpdate, nextId } from './state';
import { snapshotHarness } from './harness';
import type { ChatState, Snapshot, Entry } from './shared';

export type TelegramSession = Pick<Snapshot,'id'|'cwd'|'title'|'sessionNumber'>;
export type TelegramPermission = ChatState['permissions'][number];
export interface TelegramTurnResult {text:string;status:'completed'|'cancelled'|'failed';error?:string}
export interface TelegramTurnListener {update(text:string):void;permission(permission:TelegramPermission):void}
export interface TelegramSessionHost {
  list():Promise<TelegramSession[]>;
  create(workspace?:string):Promise<TelegramSession>;
  run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult>;
  cancel(id:string):Promise<boolean>;
  permission(id:string,permissionId:string,optionId?:string):boolean|Promise<boolean>;
  history?(id:string):Promise<Entry[]>;
  control?(id:string,action:'takeover'|'desktop'|'status'):Promise<any>;
  dispose():Promise<void>;
}
interface Task {
  text?:string;agent?:AgentProcess;cancelled:boolean;timer?:ReturnType<typeof setTimeout>;
  permissions:Map<string,{permission:TelegramPermission;options:string[];resolve:(option?:string)=>void}>;
  done:Promise<void>;settled:()=>void;
}
export interface TelegramAgentConfig {
  workspaces:Record<string,string>; command:string;args:string[];env?:Record<string,string>;maxConcurrent:number;
}

/** Headless client of the same ACP and shared-history lease boundary used by VS Code. */
export class TelegramSessions implements TelegramSessionHost {
  private tasks = new Map<string,Task>();
  private creating = 0;
  private creators = new Map<AgentProcess,Promise<void>>();
  private closed = false;
  constructor(private store:SharedHistoryStore, private config:TelegramAgentConfig,
    private makeAgent:(options:AgentOptions)=>AgentProcess=options=>new AgentProcess(options)) {}

  async list() {
    const roots = Object.values(this.config.workspaces);
    return (await this.store.list()).filter(s => roots.includes(s.cwd) && snapshotHarness(s)==='pi');
  }
  async control(id:string,action:'takeover'|'desktop'|'status'){
    if(!(await this.list()).some(s=>s.id===id))throw new Error('会话不在允许的工作区内。');
    const task=this.tasks.get(id);return {desktop:false,busy:!!task,text:task?.text||'',permissions:task?[...task.permissions.values()].map(p=>p.permission):[]};
  }
  async history(id:string) {
    const snapshot=(await this.list()).find(s=>s.id===id);
    if(!snapshot)throw new Error('会话不在允许的工作区内。');
    return (await this.store.read(snapshot)).entries;
  }
  private capacity() {
    if (this.closed) throw new Error('Telegram 服务正在停止。');
    if (this.tasks.size + this.creating >= this.config.maxConcurrent) throw new Error('并行任务已满，请等待一个任务结束后重试。');
  }
  private agent(cwd:string, callbacks:Pick<AgentOptions,'update'|'permission'>) {
    return this.makeAgent({cwd,command:this.config.command,args:this.config.args,env:{...this.config.env,PI_TELEGRAM_BOT_TOKEN:''},
      ...callbacks, log:()=>{}, closed:()=>{}});
  }
  async create(workspace?:string) {
    this.capacity();
    const names = Object.keys(this.config.workspaces);
    const cwd = this.config.workspaces[workspace || (names.length===1?names[0]:'')];
    if (!cwd) throw new Error(`请指定工作区：/new ${names.join(' 或 /new ')}`);
    const agent = this.agent(cwd, {update:()=>{},permission:async()=>({outcome:{outcome:'cancelled'}})});
    this.creating++;
    let settled!:()=>void;
    this.creators.set(agent,new Promise(resolve=>{settled=resolve;}));
    let id:string|undefined;
    try {
      await agent.initialize();
      if (this.closed) throw new Error('Telegram 服务正在停止。');
      const session = await agent.createSession();
      id = session.sessionId;
      await this.store.claim(id);
      return await this.store.write({id,cwd,title:'新对话',updated:Date.now(),entries:[],harness:'pi',
        contextComplete:true,contextPending:false,configs:session.configOptions||undefined,modes:session.modes||undefined});
    } finally {
      agent.dispose();this.creating--;
      try {if(id)await this.store.release(id);} finally {this.creators.delete(agent);settled();}
    }
  }
  async run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult> {
    if (this.tasks.has(id)) throw new Error('此会话正在执行任务，请等待或发送 /stop。');
    this.capacity();
    let settled!:()=>void;
    const done=new Promise<void>(resolve=>{settled=resolve;});
    const task:Task = {cancelled:false,permissions:new Map(),done,settled};
    this.tasks.set(id,task);
    let claimed=false, state=initialState(), start=0;
    const answer = () => state.entries.slice(start).filter(e=>e.role==='assistant').map(e=>'text' in e?e.text:'').join('\n\n');
    const finishPermissions = () => {for(const p of task.permissions.values())p.resolve();task.permissions.clear();};
    try {
      const index = (await this.list()).find(s=>s.id===id);
      if (!index) throw new Error('会话不存在、已删除或不在允许的工作区中。');
      await this.store.claim(id); claimed=true;
      const snapshot = await this.store.read(index as Snapshot);
      if(task.cancelled||this.closed)return {text:'',status:'cancelled'};
      if (snapshot.contextPending) throw new Error('此旧会话尚未同步重建上下文，请先在 VS Code 完成同步。');
      state = {...state,sessionId:id,entries:structuredClone(snapshot.entries),configs:snapshot.configs,modes:snapshot.modes};
      let replay=true;
      const replayState=initialState();
      const agent = this.agent(snapshot.cwd, {
        update:n => {
          if(n.sessionId!==id)return;
          if(replay)applyUpdate(replayState,n.update,true);
          else {applyUpdate(state,n.update);task.text=answer();listener.update(task.text);}
        },
        permission:request => {
          if(replay||task.cancelled||request.sessionId!==id)return Promise.resolve({outcome:{outcome:'cancelled'}});
          const permissionId = randomUUID();
          return new Promise(resolve => {
            const timer = setTimeout(() => settle(), 5*60*1000);
            const settle = (option?:string) => {
              clearTimeout(timer);task.permissions.delete(permissionId);
              resolve({outcome:option?{outcome:'selected',optionId:option}:{outcome:'cancelled'}});
            };
            task.permissions.set(permissionId,{permission:{id:permissionId,request},options:request.options.map(o=>o.optionId),resolve:settle});
            listener.permission({id:permissionId,request});
          });
        },
      });
      task.agent=agent;
      await agent.initialize();
      const session=await agent.createSession(id);
      if(task.cancelled||this.closed)return {text:'',status:'cancelled'};
      if(!snapshot.contextComplete && replayState.entries.length)state.entries=replayState.entries;
      state.configs=session.configOptions||state.configs;state.modes=session.modes||state.modes;
      replay=false;
      state.entries.push({id:nextId(),role:'user',text,contextBlocks:[{type:'text',text}]});
      start=state.entries.length;
      const firstUser=state.entries.find(e=>e.role==='user');
      const save = () => this.store.write({...snapshot,entries:state.entries,configs:state.configs,modes:state.modes,
        title:firstUser&&'text' in firstUser?firstUser.text.slice(0,70)||snapshot.title:snapshot.title,updated:Date.now()});
      await save();
      let result:TelegramTurnResult;
      try {
        if(task.cancelled)return {text:'',status:'cancelled'};
        const response=await agent.prompt(id,[{type:'text',text}]);
        const cancelled=task.cancelled||response.stopReason==='cancelled';
        if(response.stopReason!=='end_turn')state.entries.push({id:nextId(),role:'notice',text:`本轮结束：${response.stopReason}`});
        result={text:answer(),status:cancelled?'cancelled':response.stopReason==='end_turn'?'completed':'failed'};
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);
        state.entries.push({id:nextId(),role:'notice',text:task.cancelled?'本轮已停止。':`本轮失败：${message}`});
        result={text:answer(),status:task.cancelled?'cancelled':'failed',error:message};
      }
      await save();
      return result;
    } finally {
      finishPermissions();if(task.timer)clearTimeout(task.timer);task.agent?.dispose();
      try {if(claimed)await this.store.release(id);} finally {this.tasks.delete(id);task.settled();}
    }
  }
  async cancel(id:string) {
    const task=this.tasks.get(id);if(!task)return false;
    task.cancelled=true;
    for(const p of task.permissions.values())p.resolve();
    if(task.agent){
      task.timer ||= setTimeout(()=>task.agent?.dispose(),5000);
      await task.agent.cancel(id).catch(()=>{});
    }
    return true;
  }
  permission(id:string,permissionId:string,optionId?:string) {
    const permission=this.tasks.get(id)?.permissions.get(permissionId);
    if(!permission || optionId!==undefined&&!permission.options.includes(optionId))return false;
    permission.resolve(optionId);return true;
  }
  leaseLost(id:string) {
    const task=this.tasks.get(id);
    if(task){task.cancelled=true;task.agent?.dispose();}
  }
  async dispose() {
    this.closed=true;
    for(const [id,task] of this.tasks){void this.cancel(id);task.agent?.dispose();}
    for(const agent of this.creators.keys())agent.dispose();
    // Leases are released by each task's finally, after its last snapshot write.
    await Promise.all([...this.tasks.values()].map(task=>task.done).concat([...this.creators.values()]));
  }
}
