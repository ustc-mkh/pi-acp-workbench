import {createServer,createConnection,type Server,type Socket} from 'node:net';
import {mkdir,chmod,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {telegramDirectory} from './telegram-events';

export interface DesktopRequest {sessionId:string;action:'prompt'|'cancel'|'permission'|'takeover'|'desktop'|'status';text?:string;permissionId?:string;optionId?:string}
export interface DesktopEvent {kind:'update'|'permission';value:any}
const socketPath=(directory:string,id:string)=>join(directory,createHash('sha256').update(id).digest('hex').slice(0,24)+'.sock');
export class DesktopUnavailable extends Error {}

/** Local account-only transport. A missing endpoint permits lease-based headless fallback;
 * disconnecting after dispatch never permits replay on a second agent. */
export class DesktopClient {
  private sockets=new Set<Socket>();
  constructor(private directory=join(telegramDirectory(),'control')){}
  request<T>(request:DesktopRequest,event:(event:DesktopEvent)=>void=()=>{}):Promise<T>{
    return new Promise((resolve,reject)=>{
      let dispatched=false,done=false,buffer='';
      const socket=createConnection(socketPath(this.directory,request.sessionId));this.sockets.add(socket);
      const timer=setTimeout(()=>socket.destroy(new Error('桌面连接超时。')),5000);
      const finish=(error?:Error,result?:T)=>{if(done)return;done=true;clearTimeout(timer);this.sockets.delete(socket);socket.destroy();error?reject(error):resolve(result!);};
      socket.on('connect',()=>{clearTimeout(timer);dispatched=true;socket.write(JSON.stringify(request)+'\n');});
      socket.on('error',(error:NodeJS.ErrnoException)=>finish(!dispatched&&['ENOENT','ECONNREFUSED'].includes(error.code||'')?new DesktopUnavailable():error));
      socket.on('close',()=>finish(new Error('桌面连接已断开；为避免重复执行，任务不会自动重发。')));
      socket.on('data',data=>{
        buffer+=data.toString();if(buffer.length>16*1024*1024){finish(new Error('桌面响应过大。'));return;}
        let end:number;while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          try {const item=JSON.parse(line);if(item.kind==='result')finish(undefined,item.value);else if(item.kind==='error')finish(new Error(item.value));else event(item);}
          catch(error){finish(error instanceof Error?error:new Error(String(error)));}
        }
      });
    });
  }
  dispose(){for(const socket of this.sockets)socket.destroy();this.sockets.clear();}
}

export class DesktopServer {
  private desired?:string;
  private pending=Promise.resolve();
  private server?:Server;
  private file?:string;
  private sockets=new Set<Socket>();
  private closed=false;
  constructor(private handle:(request:DesktopRequest,event:(event:DesktopEvent)=>void)=>Promise<unknown>,
    private report:(error:unknown)=>void,private directory=join(telegramDirectory(),'control')){}
  bind(id?:string){
    if(this.closed||id===this.desired)return;
    this.desired=id;
    this.pending=this.pending.catch(this.report).then(async()=>{
      this.close();if(!id||this.closed)return;
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const file=socketPath(this.directory,id);await rm(file,{force:true});
      if(this.closed)return;
      const server=createServer(socket=>{
        this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});
        let buffer='',accepted=false;
        socket.setTimeout(5000,()=>{if(!accepted)socket.destroy();});
        socket.on('data',data=>{
          if(accepted)return;buffer+=data.toString();if(buffer.length>65536){socket.destroy();return;}
          if(!buffer.includes('\n'))return;
          accepted=true;socket.setTimeout(0);
          const send=(value:unknown)=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n');};
          void (async()=>{
            const request=JSON.parse(buffer.slice(0,buffer.indexOf('\n'))) as DesktopRequest;
            if(request.sessionId!==id||!['prompt','cancel','permission','takeover','desktop','status'].includes(request.action))throw new Error('桌面请求无效。');
            const value=await this.handle(request,event=>send(event));send({kind:'result',value});
          })().catch(error=>send({kind:'error',value:error instanceof Error?error.message:String(error)}));
        });
      });
      this.server=server;this.file=file;
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(file,()=>{server.removeListener('error',reject);server.on('error',this.report);resolve();});});
      await chmod(file,0o600);
    }).catch(this.report);
  }
  private close(){for(const socket of this.sockets)socket.destroy();this.sockets.clear();this.server?.close();this.server=undefined;this.file=undefined;}
  async dispose(){this.closed=true;this.close();await this.pending;this.close();}
}
