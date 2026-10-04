import {isAbsolute} from 'node:path';
import type {ChatState,Snapshot,Entry} from './shared';
import type {ServiceState} from './session-protocol';
import {SessionClient} from './session-wire';

export type TelegramSession=Pick<Snapshot,'id'|'cwd'|'title'|'sessionNumber'>;
export type TelegramPermission=ChatState['permissions'][number];
export interface TelegramTurnResult {status:'completed'|'cancelled'|'failed';error?:string}
export interface TelegramTurnListener {permission(permission:TelegramPermission):void}
export interface TelegramSessionStatus {busy:boolean;permissions:TelegramPermission[];text:string;error?:string}
export interface TelegramSessionHost {
  list():Promise<TelegramSession[]>;
  create(workspace?:string):Promise<TelegramSession>;
  run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult>;
  cancel(id:string):Promise<boolean>;
  permission(id:string,permissionId:string,optionId?:string):boolean|Promise<boolean>;
  history(id:string):Promise<Entry[]>;
  status(id:string):Promise<TelegramSessionStatus>;
  dispose():Promise<void>;
}
/** Current service client only: no alternate execution or delivery backend. */
export class TelegramSessions implements TelegramSessionHost {
  private client:SessionClient;
  private listeners=new Map<string,TelegramTurnListener>();
  constructor(private workspaces:Record<string,string>,socket?:string) {
    this.client=new SessionClient(socket,event=>{
      if(event.type==='state')for(const permission of event.permissions)this.listeners.get(event.snapshot.id)?.permission(permission);
    });
  }
  async list() {return this.client.call<Snapshot[]>('list');}
  async create(workspace?:string) {
    const names=Object.keys(this.workspaces);
    const cwd=workspace&&isAbsolute(workspace)?workspace:this.workspaces[workspace||(names.length===1?names[0]:'')];
    if(!cwd)throw new Error(`请指定绝对目录路径或工作区别名：${names.join(', ')}`);
    return this.client.call<Snapshot>('create',{cwd},undefined,0);
  }
  async history(id:string) {return (await this.client.call<ServiceState>('state',{sessionId:id})).snapshot.entries;}
  async run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult> {
    this.listeners.set(id,listener);
    try {
      await this.client.watch(id);
      const result=await this.client.call<{stopReason:string}>('prompt',{sessionId:id,prompt:[{type:'text',text}],source:'telegram'},undefined,0);
      return {status:result.stopReason==='end_turn'?'completed':result.stopReason==='cancelled'?'cancelled':'failed'};
    } finally {this.listeners.delete(id);await this.client.watch(id,false).catch(()=>{});}
  }
  async cancel(id:string) {return this.client.call<boolean>('cancel',{sessionId:id});}
  async permission(id:string,permissionId:string,optionId?:string) {return this.client.call<boolean>('permission',{sessionId:id,permissionId,optionId});}
  async status(id:string):Promise<TelegramSessionStatus> {
    const state=await this.client.call<ServiceState>('state',{sessionId:id});
    const last=state.snapshot.entries.map(e=>e.role).lastIndexOf('user');
    return {busy:state.busy,permissions:state.permissions,error:state.error,
      text:state.snapshot.entries.slice(last+1).filter(e=>e.role==='assistant'||e.role==='diff').map(e=>'text'in e?e.text:'').join('\n\n')};
  }
  async dispose() {this.client.dispose();}
}
