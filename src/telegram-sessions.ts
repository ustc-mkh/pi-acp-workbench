import type {ChatState,Snapshot,Entry} from './shared';
import type {ServiceState} from './session-service';
import {SessionClient} from './session-wire';
export type TelegramSession=Pick<Snapshot,'id'|'cwd'|'title'|'sessionNumber'>;
export type TelegramPermission=ChatState['permissions'][number];
export interface TelegramTurnResult {text:string;status:'completed'|'cancelled'|'failed';error?:string}
export interface TelegramTurnListener {update(text:string):void;permission(permission:TelegramPermission):void}
export interface TelegramSessionHost {
 managedDelivery?:boolean;
 list():Promise<TelegramSession[]>;create(workspace?:string):Promise<TelegramSession>;
 run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult>;
 cancel(id:string):Promise<boolean>;permission(id:string,permissionId:string,optionId?:string):boolean|Promise<boolean>;
 history?(id:string):Promise<Entry[]>;control?(id:string,action:'takeover'|'desktop'|'status'):Promise<any>;dispose():Promise<void>;
}
/** Telegram is a client only. No process spawning, leases or history writes. */
export class TelegramSessions implements TelegramSessionHost {
 readonly managedDelivery=true;
 private client:SessionClient;
 private listeners=new Map<string,TelegramTurnListener>();
 constructor(private workspaces:Record<string,string>,socket?:string){this.client=new SessionClient(socket,event=>{if(event.type==='state')for(const p of event.permissions)this.listeners.get(event.snapshot.id)?.permission(p);});}
 async list(){return (await this.client.call<Snapshot[]>('list')).filter(s=>Object.values(this.workspaces).includes(s.cwd));}
 private async allowed(id:string){if(!(await this.list()).some(s=>s.id===id))throw new Error('会话不在 Telegram 允许的工作区');}
 async create(workspace?:string){const names=Object.keys(this.workspaces),cwd=this.workspaces[workspace||(names.length===1?names[0]:'')];if(!cwd)throw new Error(`请指定工作区：${names.join(', ')}`);return this.client.call<Snapshot>('create',{cwd},undefined,0);}
 async history(id:string){await this.allowed(id);return (await this.client.call<ServiceState>('state',{sessionId:id})).snapshot.entries;}
 async run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult>{await this.allowed(id);
  this.listeners.set(id,listener);try {
  const result=await this.client.call<{stopReason:string}>('prompt',{sessionId:id,prompt:[{type:'text',text}]},undefined,0);
  const state=await this.client.call<ServiceState>('state',{sessionId:id});
  const last=state.snapshot.entries.map(e=>e.role).lastIndexOf('user');
  return {text:state.snapshot.entries.slice(last+1).filter(e=>e.role==='assistant').map(e=>'text'in e?e.text:'').join('\n\n'),status:result.stopReason==='end_turn'?'completed':result.stopReason==='cancelled'?'cancelled':'failed'};
  }finally{this.listeners.delete(id);}
 }
 async cancel(id:string){await this.allowed(id);return this.client.call<boolean>('cancel',{sessionId:id});}
 async permission(id:string,permissionId:string,optionId?:string){await this.allowed(id);return this.client.call<boolean>('permission',{sessionId:id,permissionId,optionId});}
 async control(id:string,_action:'takeover'|'desktop'|'status'){await this.allowed(id);const s=await this.client.call<ServiceState>('state',{sessionId:id});const last=s.snapshot.entries.map(e=>e.role).lastIndexOf('user');return {busy:s.busy,permissions:s.permissions,text:s.snapshot.entries.slice(last+1).filter(e=>e.role==='assistant').map(e=>'text'in e?e.text:'').join('\n\n'),error:s.error};}
 async dispose(){this.client.dispose();}
}
