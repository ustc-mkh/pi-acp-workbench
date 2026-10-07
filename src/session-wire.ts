import {createConnection,createServer,type Socket,type Server} from 'node:net';
import {mkdir,chmod,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export const sessionSocket=()=>join(homedir(),'.pi','pi-acp-workbench','service','sessions.sock');
const LIMIT=16*1024*1024;
export const WIRE_LIMITS={connections:32,pending:128,pendingBytes:32*1024*1024,partialMs:10000,responseBytes:64*1024*1024,outgoingBytes:128*1024*1024};
function reader(socket:Socket,receive:(value:any,bytes:number)=>void,adjust:(delta:number)=>boolean=()=>true){
  socket.setEncoding('utf8');let buffer='',bytes=0,timer:NodeJS.Timeout|undefined;
  const release=()=>{adjust(-bytes);bytes=0;buffer='';clearTimeout(timer);timer=undefined;};
  socket.once('close',release);
  socket.on('data',data=>{
    const added=Buffer.byteLength(data);bytes+=added;
    if(!adjust(added)||bytes>LIMIT){socket.destroy(new Error('会话消息缓冲已满'));release();return;}
    buffer+=data;
    let end;while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end),size=Buffer.byteLength(line)+1;buffer=buffer.slice(end+1);bytes-=size;adjust(-size);
      try{receive(JSON.parse(line),size);}catch{socket.destroy(new Error('会话协议无效'));release();return;}
      if(socket.destroyed){release();return;}
    }
    if(!buffer){clearTimeout(timer);timer=undefined;}
    else {
      // Detach the remainder once per chunk so V8 slices cannot retain the whole source.
      buffer=Buffer.from(buffer).toString('utf8');
      if(!timer){timer=setTimeout(()=>socket.destroy(new Error('会话消息未完整发送')),WIRE_LIMITS.partialMs);timer.unref();}
    }
  });
}
/** Responses are fragmented, requests remain single bounded frames. One transfer per socket. */
function responseReader(socket:Socket,receive:(value:any)=>void){
  let parts:string[]=[],bytes=0,timer:NodeJS.Timeout|undefined;
  const reset=()=>{parts=[];bytes=0;clearTimeout(timer);timer=undefined;};
  socket.once('close',reset);
  reader(socket,item=>{
    if(item&&Object.hasOwn(item,'fragment')){
      if(typeof item.fragment!=='string'||!item.fragment.length||typeof item.last!=='boolean'||parts.length>=2048)throw new Error('无效分块');
      bytes+=Buffer.byteLength(item.fragment);
      if(bytes>WIRE_LIMITS.responseBytes)throw new Error('响应过大');
      parts.push(item.fragment);clearTimeout(timer);
      if(item.last){const text=parts.join('');reset();receive(JSON.parse(text));}
      else {timer=setTimeout(()=>socket.destroy(new Error('会话响应未完整发送')),WIRE_LIMITS.partialMs);timer.unref();}
    }else {if(parts.length)throw new Error('分块响应交错');receive(item);}
  });
}
function encode(value:unknown,limit=LIMIT){const body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>limit)throw new Error('会话消息过大');return body;}
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
      responseReader(socket,item=>{if(item.event){this.event(item.event);return;}const p=this.pending.get(item.id);if(!p)return;this.pending.delete(item.id);clearTimeout(p.timer);item.error?p.reject(Object.assign(new Error(item.error), {code:item.code})):p.resolve(item.value);});
    });
  }
  watch(sessionId:string,enabled=true){return this.call('_watch',{sessionId,enabled});}
  async call<T=any>(method:string,params:unknown={},id:string=randomUUID(),timeout=30000):Promise<T>{
    await this.connect();if(this.closed||!this.socket||this.socket.destroyed)throw new Error('会话连接已关闭');
    if(this.pending.size>=WIRE_LIMITS.pending)throw new Error('会话客户端待处理请求已满');
    const body=encode({id,method,params});
    return new Promise((resolve,reject)=>{if(this.pending.has(id)){reject(new Error('请求仍在等待'));return;}
      const timer=timeout?setTimeout(()=>{this.pending.delete(id);reject(new Error(`会话服务请求超时（${method}，等待 ${timeout/1000} 秒）；请查看状态，不会自动重发。`));},timeout):undefined;
      this.pending.set(id,{resolve,reject,timer});sendBody(this.socket!,body);});
  }
  /** Free a pending slot after the caller has given up on its result. The service reply is ignored. */
  cancelPending(id:string){const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);p.reject(new Error('会话请求已被客户端放弃，服务端结果将被忽略。'));}
  dispose(){this.closed=true;this.socket?.destroy();}
}
interface Outgoing {queue:{body:string;bytes:number}[];bytes:number;writing:boolean;subscriptions:Set<string>}
export class SessionServer {
  private server?:Server;private sockets=new Set<Socket>();private bufferedBytes=0;private pending=0;private pendingBytes=0;
  private outgoing=new Map<Socket,Outgoing>();private outgoingBytes=0;
  constructor(private path:string,private handle:(method:string,params:any,id:string,emit:(event:unknown)=>void)=>Promise<unknown>){}
  private enqueue(socket:Socket,body:string){
    const state=this.outgoing.get(socket);if(!state||socket.destroyed)return;
    const bytes=Buffer.byteLength(body);
    if(state.bytes+bytes>WIRE_LIMITS.responseBytes||this.outgoingBytes+bytes>WIRE_LIMITS.outgoingBytes){socket.destroy();return;}
    state.queue.push({body,bytes});state.bytes+=bytes;this.outgoingBytes+=bytes;
    if(!state.writing){state.writing=true;void this.flush(socket,state);}
  }
  private async frame(socket:Socket,body:string){
    if(socket.destroyed)throw new Error('连接已关闭');
    if(socket.write(body))return;
    await new Promise<void>((resolve,reject)=>{
      const done=(error?:Error)=>{clearTimeout(timer);socket.off('drain',drain);socket.off('close',close);error?reject(error):resolve();};
      const drain=()=>done(),close=()=>done(new Error('连接已关闭'));
      const timer=setTimeout(()=>{socket.destroy();done(new Error('客户端读取超时'));},WIRE_LIMITS.partialMs);timer.unref();
      socket.once('drain',drain);socket.once('close',close);
    });
  }
  private async flush(socket:Socket,state:Outgoing){
    try{
      while(state.queue.length&&!socket.destroyed){
        const item=state.queue[0];
        // Small frames avoid filling writable buffers; JSON string encoding also handles split surrogate pairs.
        if(item.bytes<=512*1024)await this.frame(socket,item.body);
        else for(let at=0;at<item.body.length;at+=128*1024){
          await this.frame(socket,encode({fragment:item.body.slice(at,at+128*1024),last:at+128*1024>=item.body.length}));
        }
        if(socket.destroyed)return;
        state.queue.shift();state.bytes-=item.bytes;this.outgoingBytes-=item.bytes;
      }
    }catch{socket.destroy();}finally{state.writing=false;}
  }
  private send(socket:Socket,value:unknown){
    if(socket.destroyed)return;
    try{this.enqueue(socket,encode(value,WIRE_LIMITS.responseBytes));}
    catch{const id=(value as {id?:string})?.id;if(id)this.enqueue(socket,encode({id,error:'会话响应超过 64 MiB，请缩小查询范围或创建新会话。'}));}
  }
  broadcast(event:unknown){
    const value=event as {snapshot?:{id:string};notification?:{sessionId:string}};
    const sessionId=value.snapshot?.id||value.notification?.sessionId;
    const targets=[...this.sockets].filter(socket=>sessionId&&this.outgoing.get(socket)?.subscriptions.has(sessionId));
    if(!targets.length)return;
    let body:string;
    try{body=encode({event},WIRE_LIMITS.responseBytes);}
    catch{body=encode({event:{type:'serviceError',sessionId,error:'会话状态超过 64 MiB，请创建新会话。'}});}
    for(const socket of targets)this.enqueue(socket,body);
  }
  async listen(){
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});await rm(this.path,{force:true});
    this.server=createServer(socket=>{
      socket.on('error',()=>{});
      if(this.sockets.size>=WIRE_LIMITS.connections){socket.destroy();return;}
      this.sockets.add(socket);
      const state:Outgoing={queue:[],bytes:0,writing:false,subscriptions:new Set()};this.outgoing.set(socket,state);
      socket.on('close',()=>{this.sockets.delete(socket);this.outgoing.delete(socket);this.outgoingBytes-=state.bytes;state.bytes=0;state.queue=[];});
      reader(socket,(item,bytes)=>{
        if(!item||typeof item.id!=='string'||item.id.length>200||typeof item.method!=='string'||!item.params||typeof item.params!=='object'){socket.destroy();return;}
        if(item.method==='_watch'){
          const {sessionId,enabled}=item.params;
          if(typeof sessionId!=='string'||sessionId.length>1000||typeof enabled!=='boolean'){this.send(socket,{id:item.id,error:'无效订阅'});return;}
          if(enabled&&state.subscriptions.size>=32&&!state.subscriptions.has(sessionId)){this.send(socket,{id:item.id,error:'订阅已满'});return;}
          if(enabled)state.subscriptions.add(sessionId);else state.subscriptions.delete(sessionId);
          this.send(socket,{id:item.id,value:true});return;
        }
        if(this.pending>=WIRE_LIMITS.pending||this.pendingBytes+bytes>WIRE_LIMITS.pendingBytes){this.send(socket,{id:item.id,error:'会话服务请求队列已满，请稍后重试。'});return;}
        this.pending++;this.pendingBytes+=bytes;
        void Promise.resolve().then(()=>this.handle(item.method,item.params,item.id,event=>this.send(socket,{event})))
          .then(value=>this.send(socket,{id:item.id,value}),error=>this.send(socket,{id:item.id,error:error instanceof Error?error.message:String(error),code:(error as {code?:string})?.code}))
          .finally(()=>{this.pending--;this.pendingBytes-=bytes;});
      },delta=>{this.bufferedBytes+=delta;return this.bufferedBytes<=WIRE_LIMITS.pendingBytes;});
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.path,resolve);});await chmod(this.path,0o600);
  }
  async dispose(){for(const socket of this.sockets)socket.destroy();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await rm(this.path,{force:true});}
}
