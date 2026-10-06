import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramApiError, telegramChunks, type TelegramTransport, type TelegramUpdate } from './telegram-api';
import { TelegramStream } from './telegram-stream';
import type { TelegramSessionHost, TelegramSession, TelegramPermission } from './telegram-sessions';
import type { TelegramTurnEvent } from './telegram-events';

export interface TelegramBridgeState {
  version:1;botId:number;chatId:number;offset?:number;
  topics:{sessionId:string;threadId:number}[];delivered:string[];
  notifications?:boolean;silent?:boolean;historySent?:Record<string,string[]>;
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
  private touched=new Map<string,number>();
  private maintenance:NodeJS.Timeout;
  private handling=0;
  private tickets=new Map<string,PermissionTicket>();
  private active=new Set<string>();
  private consuming=new Set<string>();
  private handlers=new Set<Promise<void>>();
  private username='';
  private queues=new Map<string,Promise<void>>();
  private queued=new Map<string,number>();
  private generations=new Map<string,number>();
  private syncing=new Set<string>();
  private syncingAll=false;
  constructor(private api:TelegramTransport, private host:TelegramSessionHost,
    private data:TelegramBridgeState, private options:TelegramBridgeOptions) {
    this.maintenance=setInterval(()=>this.prune(),30000);this.maintenance.unref();
  }
  private prune(){
    const now=Date.now();for(const [id,time]of this.touched)if(now-time>5*60*1000)this.dropStream(id);
    for(const [id,ticket]of this.tickets)if(ticket.expires<=now)this.tickets.delete(id);
  }
  private dropStream(id:string){this.streams.get(id)?.dispose();this.streams.delete(id);this.touched.delete(id);}

  private persist(update:(state:TelegramBridgeState)=>void) {
    // Publish the new in-memory state only after its durable write succeeds.
    this.saving=this.saving.catch(()=>{}).then(async()=>{
      const snapshot=structuredClone(this.data);update(snapshot);
      await this.options.save(snapshot);Object.assign(this.data,snapshot);
    });
    return this.saving;
  }
  private async send(text:string,threadId?:number,extra:Record<string,unknown>={}) {
    for(const chunk of telegramChunks(text)) await this.api.call('sendMessage', {
      chat_id:this.options.chatId,...(threadId?{message_thread_id:threadId}:{}),text:chunk,disable_notification:this.data.silent===true,...extra,
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
      await this.persist(state=>{state.offset=updates.length?updates[updates.length-1].update_id+1:0;}); // First setup never executes pre-configuration commands.
    }
    try {
      const known=new Set((await this.host.list()).map(s=>s.id));
      if(this.data.topics.some(t=>!known.has(t.sessionId)))
        await this.persist(state=>{state.topics=state.topics.filter(t=>known.has(t.sessionId));});
    } catch {/* The session service may still be starting; stale bindings stay until the next restart. */}
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
          try {await this.persist(state=>{state.offset=update.update_id+1;});} catch {throw new TelegramApiError(409,'无法保存 Telegram 游标，已停止接收，避免重复执行任务。');}
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
      await this.persist(state=>{state.topics.push({sessionId:session.id,threadId:topic.message_thread_id});});
      return topic.message_thread_id;
    })();
    this.topics.set(session.id,creating);
    try{return await creating;}finally{this.topics.delete(session.id);}
  }
  private stream(id:string,threadId:number) {
    this.prune();this.touched.set(id,Date.now());
    let stream=this.streams.get(id);
    if(!stream){if(this.streams.size>=32)this.dropStream(this.streams.keys().next().value!);stream=new TelegramStream(this.api,this.options.chatId,threadId,this.options.streamIntervalMs??3100,this.options.report,()=>this.data.notifications!==false,()=>this.data.silent===true);this.streams.set(id,stream);}
    return stream;
  }
  async consume(event:TelegramTurnEvent):Promise<boolean> {
    if(this.data.delivered.includes(event.id))return true;
    if(this.stopped||this.consuming.has(event.id))return false;
    this.consuming.add(event.id);
    try {
      const session=(await this.host.list()).find(s=>s.id===event.sessionId&&s.cwd===event.cwd);
      if(!session){this.dropStream(event.id);return false;}
      if(this.data.notifications===false){
        this.dropStream(event.id);
        if(event.status!=='running'){await this.persist(state=>{state.delivered=[...state.delivered,event.id].slice(-2000);});}
        return true;
      }
      const threadId=await this.ensureTopic(session),stream=this.stream(event.id,threadId);
      const text=event.inputText!==undefined?`你（VS Code）：\n${event.inputText}\n\nPi：\n${event.text||(event.status==='running'?'正在处理…':'本轮没有文本回复。')}`:event.text;
      if(event.status==='running'){stream.update(text||'正在处理…');return false;}
      const label=event.status==='completed'?'✅ 任务完成':event.status==='cancelled'?'⏹ 任务已停止':'❌ 任务失败';
      await stream.finish(text,`${label}${session.sessionNumber?' · #'+session.sessionNumber:''}${event.error?'\n'+event.error.slice(0,700):''}`);
      await this.persist(state=>{state.delivered=[...state.delivered,event.id].slice(-2000);});
      this.dropStream(event.id);
      return true;
    } catch(error) {
      // A failed final delivery remains on disk and gets a fresh stream on retry.
      this.dropStream(event.id);throw error;
    } finally {this.consuming.delete(event.id);}
  }
  async handle(update:TelegramUpdate) {
    if(this.handling>=64)throw new Error('Telegram 处理队列已满，请稍后重试。');
    this.handling++;try{await this.dispatch(update);}finally{this.handling--;}
  }
  private async dispatch(update:TelegramUpdate) {
    if(this.stopped)return;
    const callback=update.callback_query, message=callback?.message||update.message;
    const sender=callback?.from||message?.from;
    if(!message||message.chat.id!==this.options.chatId||!sender||sender.is_bot||message.sender_chat||!this.options.allowedUserIds.includes(sender.id))return;
    const threadId=message.message_thread_id;
    if(callback){
      if(callback.data==='notify:on'||callback.data==='notify:off'){
        await this.persist(state=>{state.notifications=callback.data==='notify:on';});
        if(!this.data.notifications){for(const stream of this.streams.values())stream.dispose();this.streams.clear();this.touched.clear();}
        await this.api.call('answerCallbackQuery',{callback_query_id:callback.id,text:this.data.notifications?'已开启全部会话推送':'已暂停全部会话推送'});
        await this.notificationMenu(threadId);return;
      }
      if(callback.data==='silent:on'||callback.data==='silent:off'){
        await this.persist(state=>{state.silent=callback.data==='silent:on';});
        await this.api.call('answerCallbackQuery',{callback_query_id:callback.id,text:this.data.silent?'已开启静音发送':'已关闭静音发送'});
        await this.silentMenu(threadId);return;
      }
      await this.answerPermission(callback.id,callback.data,threadId);return;
    }
    if(!message.text)return;
    const match=message.text.match(/^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/);
    if(match?.[2]&&match[2].toLowerCase()!==this.username.toLowerCase())return;
    const command=match?.[1].toLowerCase(),argument=match?.[3]?.trim();
    const binding=this.data.topics.find(t=>t.threadId===threadId);
    try {
      if(command==='start'||command==='help'||command==='commands'){
        await this.send([
          '会话与历史',
          '/new 绝对路径或工作区名 — 新建会话及话题；仅一个别名时可省略参数',
          '/sessions — 列出最近 50 个 Pi 会话',
          '/open 编号或 Session ID — 打开已有会话话题',
          '/sync — 自动建立话题并同步未导出的文字历史；大批量时重复执行继续',
          '/history — 补充本话题最近 20 条文字历史',
          '/history all — 补充本话题完整文字历史，每次最多 100 条',
          '', '任务控制',
          '/status — 查看本话题状态、当前回复和待授权操作',
          '/stop — 停止本话题任务并取消排队消息',
          '/interrupt 新消息 — 停止当前任务后发送新指令',
          '/notifications — 自动投递总开关（默认开启）；关闭后暂停自动回复和授权卡片',
          '/silent — 静音发送开关（默认关闭）；保留消息，仅关闭通知声音',
          '', '帮助',
          '/help 或 /commands — 显示全部服务命令',
          '/start — 显示本帮助',
          '', '在会话话题直接发文字即可对话。其他命令（如 /compact）原样转交 Pi；可用命令取决于 Pi 配置。',
        ].join('\n'),threadId,{disable_notification:true});return;
      }
      if(command==='silent'){await this.silentMenu(threadId);return;}
      if(command==='notifications'){await this.notificationMenu(threadId);return;}
      if(command==='sync'){
        if(this.syncingAll){await this.send('历史同步正在进行，请稍候。',threadId,{disable_notification:true});return;}
        this.syncingAll=true;
        try {
          const sessions=await this.host.list();let processed=0,created=0;
          for(const session of sessions){
            if(this.stopped)break;
            const bound=this.data.topics.some(t=>t.sessionId===session.id);
            if(bound&&!(await this.pendingHistory(session.id,true)).length)continue;
            const topic=await this.ensureTopic(session);if(!bound)created++;
            await this.syncHistory(session.id,topic,true);
            if(++processed>=20)break;
          }
          await this.send(`已同步 ${processed} 个会话，其中新建 ${created} 个话题。每次最多 20 个会话、每个会话 100 条文字消息；再次 /sync 会跳过已同步内容并继续，无需另发 /history。`,threadId,{disable_notification:true});
        }finally{this.syncingAll=false;}
        return;
      }
      if(command==='history'){
        if(!binding)throw new Error('请先用 /open 编号进入会话话题。');
        await this.syncHistory(binding.sessionId,threadId!,argument==='all');return;
      }
      if(command==='interrupt'){
        if(!binding||!argument)throw new Error('用法：/interrupt 要发送的新消息');
        if(this.queues.has(binding.sessionId))this.generations.set(binding.sessionId,(this.generations.get(binding.sessionId)||0)+1);
        await this.host.cancel(binding.sessionId);
      }
      if(command==='stop'){
        if(binding)if(this.queues.has(binding.sessionId))this.generations.set(binding.sessionId,(this.generations.get(binding.sessionId)||0)+1);
        const stopped=binding&&await this.host.cancel(binding.sessionId);
        await this.send(stopped?'正在停止本话题任务…':'本话题没有可停止的任务。',threadId);return;
      }
      if(command==='status'){
        if(!binding){await this.send('请用 /new 或 /open 创建会话话题。',threadId);return;}
        const status=await this.host.status(binding.sessionId);
        for(const p of status.permissions)await this.showPermission(binding.sessionId,threadId!,p);
        await this.send(`会话 ${binding.sessionId}\n${status.busy||this.active.has(binding.sessionId)?'正在执行':'空闲'}；排队消息：${this.queued.get(binding.sessionId)||0}\n${status.text}`,threadId,{disable_notification:true});return;
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
      if((this.queued.get(binding.sessionId)||0)>=20)throw new Error('排队消息已满，请稍后重试。');
      const previous=this.queues.get(binding.sessionId)||Promise.resolve();
      let release!:()=>void;
      const tail=new Promise<void>(resolve=>{release=resolve;});
      this.queues.set(binding.sessionId,tail);
      this.queued.set(binding.sessionId,(this.queued.get(binding.sessionId)||0)+1);
      const generation=this.generations.get(binding.sessionId)||0;
      await previous;
      this.active.add(binding.sessionId);
      try {
        if(this.stopped||generation!==(this.generations.get(binding.sessionId)||0))return;
        const prompt=command==='interrupt'?argument!:match?.[2]?`/${match[1]}${argument?' '+argument:''}`:message.text;
        // Only the session service publishes progress and completion to the durable outbox.
        await this.host.run(binding.sessionId,prompt,{
          permission:p=>{if(this.data.notifications!==false)void this.showPermission(binding.sessionId,threadId!,p).catch(error=>this.options.report(error));},
        });
      } finally {
        this.active.delete(binding.sessionId);
        const remaining=(this.queued.get(binding.sessionId)||1)-1;
        if(remaining)this.queued.set(binding.sessionId,remaining);else{this.queued.delete(binding.sessionId);this.generations.delete(binding.sessionId);}
        if(this.queues.get(binding.sessionId)===tail)this.queues.delete(binding.sessionId);
        release();
        for(const [key,ticket]of this.tickets)if(ticket.sessionId===binding.sessionId)this.tickets.delete(key);
      }
    } catch(error) {
      const detail=error instanceof Error?error.message:String(error);
      this.options.report(error);
      if(command||this.data.notifications!==false)await this.send(detail,threadId).catch(error=>this.options.report(error));
    }
  }
  private async notificationMenu(threadId?:number){
    await this.send(`全部会话自动推送（默认开启）：${this.data.notifications!==false?'开启':'关闭'}。关闭时不发送自动回复、完成通知或授权卡片；可用 /history、/status 主动查看。`,threadId,
      {disable_notification:true,reply_markup:{inline_keyboard:[[{text:this.data.notifications!==false?'暂停全部推送':'开启全部推送',callback_data:this.data.notifications!==false?'notify:off':'notify:on'}]]}});
  }
  private async silentMenu(threadId?:number){
    await this.send(`静音发送：${this.data.silent===true?'开启':'关闭'}（默认关闭）。静音不阻止消息投递，仅关闭通知声音；手机仍可能显示无声通知。自动投递总开关由 /notifications 控制。`,threadId,
      {disable_notification:true,reply_markup:{inline_keyboard:[[{text:this.data.silent===true?'关闭静音':'开启静音',callback_data:this.data.silent===true?'silent:off':'silent:on'}]]}});
  }
  private async pendingHistory(id:string,all:boolean){
    const entries=(await this.host.history(id)).filter(e=>e.role==='user'||e.role==='assistant'||e.role==='diff');
    const sent=this.data.historySent&&Object.hasOwn(this.data.historySent,id)?this.data.historySent[id]:[];
    return (all?entries:entries.slice(-20)).map(e=>({key:createHash('sha256').update(e.id+'\0'+('text' in e?e.text:'')).digest('hex'),text:`${e.role==='user'?'你':e.role==='diff'?'修改汇总':'Pi'}：\n${'text' in e?e.text:''}`})).filter(e=>!sent.includes(e.key)).slice(0,100);
  }
  private async syncHistory(id:string,threadId:number,all:boolean){
    if(this.syncing.has(id))throw new Error('此话题正在同步历史。');
    this.syncing.add(id);
    try{
      const selected=await this.pendingHistory(id,all);
      for(const entry of selected){
        await this.send(entry.text,threadId,{disable_notification:true});
        await this.persist(state=>{state.historySent||={};Object.defineProperty(state.historySent,id,{value:[...(Object.hasOwn(state.historySent,id)?state.historySent[id]:[]),entry.key],enumerable:true,writable:true,configurable:true});});
      }
      await this.send(`已同步 ${selected.length} 条历史消息。${selected.length===100?'可再次 /history all 继续。':''}`,threadId,{disable_notification:true});
    }finally{this.syncing.delete(id);}
  }
  private async showPermission(sessionId:string,threadId:number,permission:TelegramPermission) {
    for(const [key,ticket] of this.tickets)if(ticket.expires<=Date.now())this.tickets.delete(key);
    const existing=[...this.tickets].find(([,ticket])=>ticket.sessionId===sessionId&&ticket.permissionId===permission.id&&ticket.threadId===threadId);
    const key=existing?.[0]||randomBytes(10).toString('hex');
    const options=[...permission.request.options.map(o=>o.optionId),undefined];
    if(!existing&&this.tickets.size>=128)this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(key,{sessionId,threadId,permissionId:permission.id,options,expires:existing?.[1].expires??Date.now()+5*60*1000});
    const buttons=permission.request.options.map((o,i)=>[{text:o.name.slice(0,60),callback_data:`p:${key}:${i}`}]);
    buttons.push([{text:'取消',callback_data:`p:${key}:${options.length-1}`}]);
    await this.send(`需要授权：${permission.request.toolCall.title||'工具操作'}\n${JSON.stringify(permission.request.toolCall,null,2).slice(0,2600)}`,threadId,{reply_markup:{inline_keyboard:buttons}});
  }
  private async answerPermission(callbackId:string,data:string|undefined,threadId?:number) {
    const match=data?.match(/^p:([a-f0-9]{20}):(\d+)$/),ticket=match?this.tickets.get(match[1]):undefined;
    const index=Number(match?.[2]);
    const accepted=!!ticket&&ticket.threadId===threadId&&ticket.expires>Date.now()&&Number.isInteger(index)&&index<ticket.options.length&&await this.host.permission(ticket.sessionId,ticket.permissionId,ticket.options[index]);
    if(accepted)this.tickets.delete(match![1]);
    await this.api.call('answerCallbackQuery',{callback_query_id:callbackId,text:accepted?'已提交':'授权已失效或不属于此话题。'});
  }
  async dispose() {
    this.stopped=true;clearInterval(this.maintenance);this.abort.abort();this.api.dispose();
    for(const stream of this.streams.values())stream.dispose();
    this.streams.clear();this.touched.clear();this.tickets.clear();
    await this.host.dispose();await Promise.allSettled([...this.handlers]);await this.saving.catch(()=>{});
  }
}
