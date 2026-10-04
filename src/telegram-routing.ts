import {DesktopClient,DesktopUnavailable} from './desktop-control';
import type {TelegramSessionHost,TelegramTurnListener,TelegramTurnResult} from './telegram-sessions';

/** Always ask the existing desktop owner first; fall back only before a request was dispatched. */
export class TelegramRouting implements TelegramSessionHost {
  constructor(private local:TelegramSessionHost,private desktop=new DesktopClient()){}
  list(){return this.local.list();}
  create(workspace?:string){return this.local.create(workspace);}
  history(id:string){if(!this.local.history)throw new Error('历史读取不可用。');return this.local.history(id);}
  private async allowed(id:string){if(!(await this.list()).some(s=>s.id===id))throw new Error('会话不在允许的工作区内。');}
  async run(id:string,text:string,listener:TelegramTurnListener):Promise<TelegramTurnResult>{
    await this.allowed(id);
    try{return await this.desktop.request({sessionId:id,action:'prompt',text},event=>{
      if(event.kind==='update')listener.update(event.value);else if(event.kind==='permission')listener.permission(event.value);
    });}catch(error){if(!(error instanceof DesktopUnavailable))throw error;return this.local.run(id,text,listener);}
  }
  async cancel(id:string){
    await this.allowed(id);if(await this.local.cancel(id))return true;
    try{return await this.desktop.request<boolean>({sessionId:id,action:'cancel'});}catch(error){if(error instanceof DesktopUnavailable)return false;throw error;}
  }
  async permission(id:string,permissionId:string,optionId?:string){
    await this.allowed(id);if(await this.local.permission(id,permissionId,optionId))return true;
    try{return await this.desktop.request<boolean>({sessionId:id,action:'permission',permissionId,optionId});}catch(error){if(error instanceof DesktopUnavailable)return false;throw error;}
  }
  async control(id:string,action:'takeover'|'desktop'|'status'){
    await this.allowed(id);
    try{return await this.desktop.request<any>({sessionId:id,action});}catch(error){
      if(!(error instanceof DesktopUnavailable))throw error;
      if(action==='desktop')return true;
      return await this.local.control?.(id,action)||{desktop:false,busy:false};
    }
  }
  async dispose(){this.desktop.dispose();await this.local.dispose();}
}
