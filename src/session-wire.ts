import {createConnection,createServer,type Socket,type Server} from 'node:net';
import {mkdir,chmod,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export const sessionSocket=()=>join(homedir(),'.pi','pi-acp-workbench','service','sessions.sock');
const LIMIT=16*1024*1024;
export const WIRE_LIMITS={connections:32,pending:128,pendingBytes:32*1024*1024,partialMs:10000};
function reader(socket:Socket,receive:(value:any,bytes:number)=>void,adjust:(delta:number)=>boolean=()=>true){
  socket.setEncoding('utf8');let buffer='',bytes=0,timer:NodeJS.Timeout|undefined;
  const release=()=>{adjust(-bytes);bytes=0;buffer='';clearTimeout(timer);timer=undefined;};
  socket.once('close',release);
  socket.on('data',data=>{
    const added=Buffer.byteLength(data);bytes+=added;
    if(!adjust(added)||bytes>LIMIT){socket.destroy(new Error('会话消息缓冲已满'));release();return;}
    buffer+=data;
    let end;while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end),size=Buffer.byteLength(line)+1;buffer=Buffer.from(buffer.slice(end+1)).toString('utf8');bytes-=size;adjust(-size);
      try{receive(JSON.parse(line),size);}catch{socket.destroy(new Error('会话协议无效'));release();return;}
      if(socket.destroyed){release();return;}
    }
    if(!buffer){clearTimeout(timer);timer=undefined;}
    else if(!timer){timer=setTimeout(()=>socket.destroy(new Error('会话消息未完整发送')),WIRE_LIMITS.partialMs);timer.unref();}
  });
}
function encode(value:unknown){const body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>LIMIT)throw new Error('会话消息过大');return body;}
function sendBody(socket:Socket,body:string){if(socket.destroyed)return;if(socket.writableLength+Buffer.byteLength(body)>LIMIT){socket.destroy();return;}socket.write(body);}
export class SessionClient {
  private socket?:Socket;private connecting?:Promise<void>;private closed=false;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer?:NodeJS.Timeout}>();
  constructor(private path=sessionSocket(),private event:(value:any)=>void=()=>{},private lost:(error:string)=>void=()=>{}){}
  private connect(){
    if(this.closed)return Promise.reject(new Error('会话客户端已关闭'));
    return this.connecting ||= new Promise<void>((resolve,reject)=>{
      const socket=this.socket=createConnection(this.path);const timer=setTimeout(()=>socket.destroy(new Error('连接超时')),5000);
      socket.once('connect',()=>{clearTimeout(timer);resolve();});
      socket.on('error',()=>{});
      socket.once('close',()=>{clearTimeout(timer);const error=new Error('Pi 会话服务连接已断开。请检查 pi-sessions.service；任务不会自动重发。');reject(error);this.connecting=undefined;this.socket=undefined;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();if(!this.closed)this.lost(error.message);});
      reader(socket,item=>{if(item.event){this.event(item.event);return;}const p=this.pending.get(item.id);if(!p)return;this.pending.delete(item.id);clearTimeout(p.timer);item.error?p.reject(new Error(item.error)):p.resolve(item.value);});
    });
  }
  async call<T=any>(method:string,params:unknown={},id:string=randomUUID(),timeout=30000):Promise<T>{
    await this.connect();if(this.closed||!this.socket||this.socket.destroyed)throw new Error('会话连接已关闭');
    if(this.pending.size>=WIRE_LIMITS.pending)throw new Error('会话客户端待处理请求已满');
    // Serialization errors must not leave an immortal pending request (prompt has no timer).
    const body=encode({id,method,params});
    return new Promise((resolve,reject)=>{if(this.pending.has(id)){reject(new Error('请求仍在等待'));return;}
      const timer=timeout?setTimeout(()=>{this.pending.delete(id);reject(new Error('会话服务请求超时；请查看状态，不会自动重发。'));},timeout):undefined;
      this.pending.set(id,{resolve,reject,timer});sendBody(this.socket!,body);});
  }
  dispose(){this.closed=true;this.socket?.destroy();}
}
export class SessionServer {
  private server?:Server;private sockets=new Set<Socket>();private bufferedBytes=0;private pending=0;private pendingBytes=0;
  constructor(private path:string,private handle:(method:string,params:any,id:string,emit:(event:unknown)=>void)=>Promise<unknown>){}
  private deliver(socket:Socket,body:string){
    if(socket.destroyed)return;
    const buffered=[...this.sockets].reduce((sum,s)=>sum+s.writableLength,0);
    if(buffered+Buffer.byteLength(body)>WIRE_LIMITS.pendingBytes){socket.destroy();return;}
    sendBody(socket,body);
  }
  private send(socket:Socket,value:unknown){if(socket.destroyed)return;try{this.deliver(socket,encode(value));}catch{socket.destroy();}}
  broadcast(event:unknown){
    if(!this.sockets.size)return;
    let body:string;try{body=encode({event});}catch{for(const socket of this.sockets)socket.destroy();return;}
    for(const socket of this.sockets)this.deliver(socket,body);
  }
  async listen(){await mkdir(dirname(this.path),{recursive:true,mode:0o700});await rm(this.path,{force:true});
    this.server=createServer(socket=>{
      socket.on('error',()=>{});
      if(this.sockets.size>=WIRE_LIMITS.connections){socket.destroy();return;}
      this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));
      reader(socket,(item,bytes)=>{
        if(!item||typeof item.id!=='string'||item.id.length>200||typeof item.method!=='string'||!item.params||typeof item.params!=='object'){socket.destroy();return;}
        if(this.pending>=WIRE_LIMITS.pending||this.pendingBytes+bytes>WIRE_LIMITS.pendingBytes){this.send(socket,{id:item.id,error:'会话服务请求队列已满，请稍后重试。'});return;}
        this.pending++;this.pendingBytes+=bytes;
        void Promise.resolve().then(()=>this.handle(item.method,item.params,item.id,event=>this.send(socket,{event})))
          .then(value=>this.send(socket,{id:item.id,value}),error=>this.send(socket,{id:item.id,error:error instanceof Error?error.message:String(error)}))
          .finally(()=>{this.pending--;this.pendingBytes-=bytes;});
      },delta=>{this.bufferedBytes+=delta;return this.bufferedBytes<=WIRE_LIMITS.pendingBytes;});
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.path,resolve);});await chmod(this.path,0o600);
  }
  async dispose(){for(const socket of this.sockets)socket.destroy();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await rm(this.path,{force:true});}
}
