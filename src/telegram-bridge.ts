import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramApiError, telegramChunks, type TelegramTransport, type TelegramUpdate } from './telegram-api';
import { TelegramStream } from './telegram-stream';
import type { TelegramSessionHost, TelegramSession, TelegramPermission } from './telegram-sessions';
import type { TelegramTurnEvent, TelegramEvents } from './telegram-events';

export interface TelegramBridgeState {
  version:1;botId:number;chatId:number;offset?:number;
  topics:{sessionId:string;threadId:number}[];delivered:string[];
}
export interface TelegramBridgeOptions {
  chatId:number;allowedUserIds:number[];streamIntervalMs?:number;
  save(state:TelegramBridgeState):Promise<void>;report(error:unknown):void;
}
interface PermissionTicket {sessionId:string;permissionId:string;threadId:number;options:(string|undefined)[];expires:number}

export class TelegramBridge {
  private stopped=false;
  private abort=new AbortController();
  private saving:Promise<void>=Promise.resolve();
  private topics=new Map<string,Promise<number>>();
  private streams=new Map<string,TelegramStream>();
  private tickets=new Map<string,PermissionTicket>();
  private active=new Set<string>();
  private consuming=new Set<string>();
  private handlers=new Set<Promise<void>>();
  private username='';
  constructor(private api:TelegramTransport, private host:TelegramSessionHost, private events:TelegramEvents,
    private data:TelegramBridgeState, private options:TelegramBridgeOptions) {}

  private persist() {
    const snapshot=structuredClone(this.data);
    this.saving=this.saving.catch(()=>{}).then(()=>this.options.save(snapshot));
    return this.saving;
  }
  private async send(text:string,threadId?:number,extra:Record<string,unknown>={}) {
    for(const chunk of telegramChunks(text)) await this.api.call('sendMessage', {
      chat_id:this.options.chatId,...(threadId?{message_thread_id:threadId}:{}),text:chunk,...extra,
    });
  }
  async initialize(username:string) {
    this.username=username;
    const webhook=await this.api.call<{url:string}>('getWebhookInfo');
    if(webhook.url)throw new Error('此 Bot 已配置 webhook，请使用独立 Bot 或先在原服务中关闭 webhook。');
    const chat=await this.api.call<{type:string;is_forum?:boolean}>('getChat',{chat_id:this.options.chatId});
    if(chat.type!=='supergroup'||!chat.is_forum)throw new Error('请使用已启用 Topics 的私人超级群组，并授予 Bot 管理话题权限。');
    if(this.data.offset===undefined){
      const updates=await this.api.call<TelegramUpdate[]>('getUpdates',{offset:-1,limit:1,timeout:0,allowed_updates:['message','callback_query']});
      this.data.offset=updates.length?updates[updates.length-1].update_id+1:0;
      await this.persist(); // First setup never executes pre-configuration commands.
    }
  }
  async poll() {
    let failures=0;
    while(!this.stopped){
      try {
        const updates=await this.api.call<TelegramUpdate[]>('getUpdates',{
          offset:this.data.offset,timeout:25,allowed_updates:['message','callback_query'],
        });
        for(const update of updates){
          if(this.stopped)return;
          if(!Number.isSafeInteger(update.update_id)||update.update_id<this.data.offset!)continue;
          // At-most-once task dispatch: checkpoint before any command can reach the agent.
          this.data.offset=update.update_id+1;
          try {await this.persist();} catch {throw new TelegramApiError(409,'无法保存 Telegram 游标，已停止接收，避免重复执行任务。');}
          const handler=this.handle(update).catch(error=>this.options.report(error));
          this.handlers.add(handler);
          void handler.finally(()=>this.handlers.delete(handler));
        }
        failures=0;
      } catch(error) {
        if(this.stopped)return;
        this.options.report(error);
        if(error instanceof TelegramApiError&&[401,403,409].includes(error.code))throw error;
        await delay(Math.min(30000,1000*2**Math.min(++failures,5)),undefined,{signal:this.abort.signal}).catch(()=>{});
      }
    }
  }
  async ensureTopic(session:TelegramSession):Promise<number> {
    const saved=this.data.topics.find(t=>t.sessionId===session.id);if(saved)return saved.threadId;
    const pending=this.topics.get(session.id);if(pending)return pending;
    const creating=(async()=>{
      const topic=await this.api.call<{message_thread_id:number}>('createForumTopic',{
        chat_id:this.options.chatId,name:`${session.sessionNumber?'#'+session.sessionNumber:'Pi'} · ${session.title||'新对话'}`.slice(0,128),
      });
      this.data.topics.push({sessionId:session.id,threadId:topic.message_thread_id});
      await this.persist();
      return topic.message_thread_id;
    })();
    this.topics.set(session.id,creating);
    try{return await creating;}finally{this.topics.delete(session.id);}
  }
  private stream(id:string,threadId:number) {
    let stream=this.streams.get(id);
    if(!stream){stream=new TelegramStream(this.api,this.options.chatId,threadId,this.options.streamIntervalMs??3100,this.options.report);this.streams.set(id,stream);}
    return stream;
  }
  async consume(event:TelegramTurnEvent):Promise<boolean> {
    if(this.data.delivered.includes(event.id))return true;
    if(this.stopped||this.consuming.has(event.id))return false;
    this.consuming.add(event.id);
    try {
      const session=(await this.host.list()).find(s=>s.id===event.sessionId&&s.cwd===event.cwd);
      if(!session)return false; // Never relay another workspace's output.
      const threadId=await this.ensureTopic(session),stream=this.stream(event.id,threadId);
      if(event.status==='running'){stream.update(event.text||'正在处理…');return false;}
      const label=event.status==='completed'?'✅ 任务完成':event.status==='cancelled'?'⏹ 任务已停止':'❌ 任务失败';
      await stream.finish(event.text,`${label}${session.sessionNumber?' · #'+session.sessionNumber:''}${event.error?'\n'+event.error.slice(0,700):''}`);
      this.data.delivered=[...this.data.delivered,event.id].slice(-2000);
      await this.persist();
      this.streams.delete(event.id);
      return true;
    } catch(error) {
      // A failed final delivery remains on disk and gets a fresh stream on retry.
      this.streams.get(event.id)?.dispose();this.streams.delete(event.id);throw error;
    } finally {this.consuming.delete(event.id);}
  }
  async handle(update:TelegramUpdate) {
    if(this.stopped)return;
    const callback=update.callback_query, message=callback?.message||update.message;
    const sender=callback?.from||message?.from;
    if(!message||message.chat.id!==this.options.chatId||!sender||sender.is_bot||message.sender_chat||!this.options.allowedUserIds.includes(sender.id))return;
    const threadId=message.message_thread_id;
    if(callback){await this.answerPermission(callback.id,callback.data,threadId);return;}
    if(!message.text)return;
    const match=message.text.match(/^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/);
    if(match?.[2]&&match[2].toLowerCase()!==this.username.toLowerCase())return;
    const command=match?.[1].toLowerCase(),argument=match?.[3]?.trim();
    const binding=this.data.topics.find(t=>t.threadId===threadId);
    try {
      if(command==='start'||command==='help'){
        await this.send('/new [工作区名] — 新建会话和独立话题\n/sessions — 列出允许的 Pi 会话\n/open 编号 — 为已有会话打开话题\n/status — 查看本话题任务状态\n/stop — 停止本话题任务\n\n进入会话话题直接发文字即可；/compact 等其他命令转交 Pi。电脑占用的会话请先在 VS Code 点击“释放会话”。',threadId);return;
      }
      if(command==='stop'){
        const stopped=binding&&await this.host.cancel(binding.sessionId);
        await this.send(stopped?'正在停止本话题任务…':'本话题没有由 Telegram 执行的任务。电脑任务请在 VS Code 停止。',threadId);return;
      }
      if(command==='status'){
        await this.send(binding?`会话 ${binding.sessionId}\n${this.active.has(binding.sessionId)?'正在执行，可用 /stop 停止。':'空闲；发送文字即可继续。'}`:'请用 /new 或 /open 创建会话话题。',threadId);return;
      }
      if(command==='sessions'){
        const sessions=await this.host.list();
        await this.send(sessions.length?sessions.slice(0,50).map(s=>`/open ${s.sessionNumber||s.id} — ${s.title.slice(0,70)}`).join('\n'):'暂无会话。发送 /new 创建。',threadId);return;
      }
      if(command==='new'||command==='open'){
        const session=command==='new'?await this.host.create(argument):(await this.host.list()).find(s=>String(s.sessionNumber)===argument||s.id===argument);
        if(!session)throw new Error('找不到会话，请先用 /sessions 查看编号。');
        const topic=await this.ensureTopic(session);
        await this.send(`会话 ${session.sessionNumber?'#'+session.sessionNumber:session.id} 已连接到此话题。直接发文字开始；/stop 停止任务。`,topic);
        return;
      }
      if(!binding)throw new Error('此话题尚未绑定会话，请先发送 /new 或 /open 编号，再进入新话题。');
      if(this.active.has(binding.sessionId))throw new Error('此会话正在执行任务，请等待或发送 /stop。');
      this.active.add(binding.sessionId);
      const id=`telegram:${this.data.botId}:${update.update_id}`,stream=this.stream(id,threadId!);
      let completionSaved=false;
      try {
        const prompt=match?.[2]?`/${match[1]}${argument?' '+argument:''}`:message.text;
        const result=await this.host.run(binding.sessionId,prompt,{
          update:text=>stream.update(text||'正在处理…'),
          permission:p=>{void this.showPermission(binding.sessionId,threadId!,p).catch(error=>this.options.report(error));},
        });
        const session=(await this.host.list()).find(s=>s.id===binding.sessionId);
        if(!session)throw new Error('任务结束，但会话已删除；请查看服务器日志。');
        const event:TelegramTurnEvent={...session,id,sessionId:session.id,text:result.text,status:result.status,error:result.error,updated:Date.now()};
        await this.events.write(event); // Durable completion outbox; network failure cannot lose the result.
        completionSaved=true;
        if(await this.consume(event))await this.events.remove(event.id);
      } finally {
        if(!completionSaved){stream.dispose();this.streams.delete(id);}
        this.active.delete(binding.sessionId);
        for(const [key,ticket]of this.tickets)if(ticket.sessionId===binding.sessionId)this.tickets.delete(key);
      }
    } catch(error) {
      const detail=error instanceof Error?error.message:String(error);
      this.options.report(error);
      await this.send(detail,threadId).catch(error=>this.options.report(error));
    }
  }
  private async showPermission(sessionId:string,threadId:number,permission:TelegramPermission) {
    const key=randomBytes(10).toString('hex');
    const options=[...permission.request.options.map(o=>o.optionId),undefined];
    this.tickets.set(key,{sessionId,threadId,permissionId:permission.id,options,expires:Date.now()+5*60*1000});
    const buttons=permission.request.options.map((o,i)=>[{text:o.name.slice(0,60),callback_data:`p:${key}:${i}`}]);
    buttons.push([{text:'取消',callback_data:`p:${key}:${options.length-1}`}]);
    await this.send(`需要授权：${permission.request.toolCall.title||'工具操作'}\n${JSON.stringify(permission.request.toolCall,null,2).slice(0,2600)}`,threadId,{reply_markup:{inline_keyboard:buttons}});
  }
  private async answerPermission(callbackId:string,data:string|undefined,threadId?:number) {
    const match=data?.match(/^p:([a-f0-9]{20}):(\d+)$/),ticket=match?this.tickets.get(match[1]):undefined;
    const index=Number(match?.[2]);
    const accepted=!!ticket&&ticket.threadId===threadId&&ticket.expires>Date.now()&&Number.isInteger(index)&&index<ticket.options.length&&this.host.permission(ticket.sessionId,ticket.permissionId,ticket.options[index]);
    if(accepted)this.tickets.delete(match![1]);
    await this.api.call('answerCallbackQuery',{callback_query_id:callbackId,text:accepted?'已提交':'授权已失效或不属于此话题。'});
  }
  async dispose() {
    this.stopped=true;this.abort.abort();this.api.dispose();
    for(const stream of this.streams.values())stream.dispose();
    this.streams.clear();this.tickets.clear();
    await this.host.dispose();await Promise.allSettled([...this.handlers]);await this.saving.catch(()=>{});
  }
}
