import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TelegramApi,telegramChunks,type TelegramTransport,type TelegramUpdate} from '../src/telegram-api';
import {TelegramBridge,type TelegramBridgeState} from '../src/telegram-bridge';
import {TelegramStream} from '../src/telegram-stream';
import {DesktopTelegramTurn,TelegramEvents} from '../src/telegram-events';
import {telegramConfig} from '../src/telegram-config';
import {initialState,applyUpdate} from '../src/state';
import type {TelegramSessionHost,TelegramTurnListener,TelegramTurnResult} from '../src/telegram-sessions';

const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const fn of cleanup.splice(0).reverse())await fn();});
class FakeApi implements TelegramTransport {
  calls:{method:string;params:Record<string,unknown>}[]=[];
  batches:TelegramUpdate[][]=[];
  wake?:()=>void;
  async call<T>(method:string,params:Record<string,unknown>={}):Promise<T> {
    this.calls.push({method,params});
    if(method==='getWebhookInfo')return {url:''} as T;
    if(method==='getChat')return {type:'supergroup',is_forum:true} as T;
    if(method==='createForumTopic')return {message_thread_id:200+this.calls.filter(c=>c.method===method).length} as T;
    if(method==='getUpdates')return (this.batches.shift()||await new Promise<TelegramUpdate[]>(r=>{this.wake=()=>r([]);})) as T;
    return {message_id:500+this.calls.length} as T;
  }
  dispose(){this.wake?.();}
}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'pi-telegram-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const api=new FakeApi(),events=new TelegramEvents(root);
  const sessions=[{id:'one',cwd:'/allowed',title:'One',sessionNumber:1},{id:'two',cwd:'/allowed',title:'Two',sessionNumber:2}];
  const host:TelegramSessionHost={list:vi.fn(async()=>sessions),create:vi.fn(async()=>sessions[1]),
    history:vi.fn(async()=>[]),status:vi.fn(async()=>({busy:false,permissions:[],text:''})),
    run:vi.fn(async():Promise<TelegramTurnResult>=>({status:'completed'})),cancel:vi.fn(async()=>true),permission:vi.fn(()=>true),dispose:vi.fn(async()=>{})};
  const saved:TelegramBridgeState[]=[];
  const data:TelegramBridgeState={version:1,botId:7,chatId:-100,offset:1,notifications:true,topics:[{sessionId:'one',threadId:101}],delivered:[]};
  const report=vi.fn();
  const save=vi.fn(async(s:TelegramBridgeState)=>{saved.push(structuredClone(s));});
  const bridge=new TelegramBridge(api,host,data,{chatId:-100,allowedUserIds:[42],streamIntervalMs:1,
    save,report});
  // Model the independent service outbox and relay sweep, not a second bridge-owned delivery path.
  let turn=0;
  vi.mocked(host.run).mockImplementation(async id=>{
    const session=sessions.find(s=>s.id===id)!;
    const event={...session,id:`service:${++turn}`,sessionId:id,text:'done',status:'completed' as const,updated:Date.now()};
    await events.write(event);
    try{if(await bridge.consume(event))await events.remove(event.id);}catch(error){report(error);}
    return {status:'completed'};
  });
  cleanup.push(()=>bridge.dispose());
  return {api,host,events,bridge,data,saved,report,sessions,save};
}
const message=(id:number,text:string,threadId=101,userId=42,chatId=-100):TelegramUpdate=>({update_id:id,message:{message_id:id,chat:{id:chatId,type:'supergroup'},from:{id:userId},message_thread_id:threadId,text}});

it('requires explicit identity/workspace configuration and redacts transport failures',async()=>{
  expect(()=>telegramConfig({chatId:-1,allowedUserIds:[],workspaces:{a:'/a'}})).toThrow('allowedUserIds');
  expect(()=>telegramConfig({chatId:-1,allowedUserIds:[42],workspaces:{a:'/a'},maxConcurrent:99})).toThrow('maxConcurrent');
  expect(telegramConfig({chatId:-1,allowedUserIds:[42],workspaces:{a:'/a'}}).workspaces).toEqual({a:'/a'});
  expect(telegramConfig({chatId:-1,allowedUserIds:[42]}).workspaces).toEqual({});
  const token='123:private_token_never_log';
  const api=new TelegramApi(token,0,vi.fn(async()=>{throw new Error(`https://api.telegram.org/bot${token}`);}) as typeof fetch);
  await expect(api.call('getMe')).rejects.toThrow('网络请求');
  await api.call('getMe').catch(error=>expect(error.message).not.toContain(token));api.dispose();
  const fetcher=vi.fn().mockResolvedValueOnce({json:async()=>({ok:false,error_code:429,parameters:{retry_after:0.001}})})
    .mockResolvedValueOnce({json:async()=>({ok:true,result:{message_id:1}})});
  const retry=new TelegramApi(token,0,fetcher as typeof fetch);
  expect(await retry.call('sendMessage',{text:'hello'})).toEqual({message_id:1});expect(fetcher).toHaveBeenCalledTimes(2);retry.dispose();
});
it('coalesces streamed text, preserves long Unicode output and sends an audible completion',async()=>{
  const api=new FakeApi(),stream=new TelegramStream(api,-100,101,1);
  cleanup.push(()=>stream.dispose());
  for(let i=0;i<100;i++)stream.update('partial '+i);
  await vi.waitFor(()=>expect(api.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1));
  const text='😀'.repeat(5000)+'last';
  expect(telegramChunks(text).join('')).toBe(text);
  expect(telegramChunks(text).every(c=>c.length<=3900&&!/[\uD800-\uDBFF]$/.test(c))).toBe(true);
  await stream.finish(text,'✅ 任务完成');
  const final=api.calls.filter(c=>c.method==='editMessageText'||c.method==='sendMessage').slice(1,-1);
  expect(final.map(c=>c.params.text).join('')).toBe(text);
  expect(api.calls.at(-1)?.params).toMatchObject({message_thread_id:101,text:'✅ 任务完成',disable_notification:false});
});
it('isolates topics, rejects unauthorized users/chats and preserves bindings for existing sessions',async()=>{
  const {api,host,bridge,data}=await fixture();
  await bridge.handle(message(1,'attack',101,99));await bridge.handle(message(2,'attack',101,42,-999));
  expect(host.run).not.toHaveBeenCalled();expect(api.calls).toHaveLength(0);
  await bridge.handle(message(3,'unbound',999));expect(host.run).not.toHaveBeenCalled();
  await bridge.handle(message(4,'hello'));expect(host.run).toHaveBeenCalledWith('one','hello',expect.anything());
  await bridge.handle(message(5,'/open 2'));await bridge.handle(message(6,'/open 2'));
  expect(api.calls.filter(c=>c.method==='createForumTopic')).toHaveLength(1);
  expect(data.topics.find(t=>t.sessionId==='two')).toBeDefined();
  await bridge.handle(message(7,'/stop'));expect(host.cancel).toHaveBeenCalledWith('one');
});
it('checkpoints update IDs before dispatch and never re-executes duplicate deliveries',async()=>{
  const {api,host,bridge,saved}=await fixture();
  vi.mocked(host.run).mockImplementation(async()=>{
    expect(saved.at(-1)!.offset).toBe(11);return {status:'completed'};
  });
  api.batches=[[message(10,'one'),message(10,'duplicate')]];
  const polling=bridge.poll();
  await vi.waitFor(()=>expect(host.run).toHaveBeenCalledOnce());
  await bridge.dispose();await polling;
  expect(host.run).toHaveBeenCalledOnce();
});
it('refuses an existing webhook and never dispatches tasks when checkpoint storage fails',async()=>{
  const {api,host,events,data}=await fixture();
  const bridge=new TelegramBridge(api,host,data,{chatId:-100,allowedUserIds:[42],
    save:async()=>{throw new Error('disk full');},report:()=>{}});
  cleanup.push(()=>bridge.dispose());
  const request=api.call.bind(api);
  api.call=async<T>(method:string,params?:Record<string,unknown>):Promise<T>=>
    method==='getWebhookInfo'?{url:'https://existing.example/webhook'} as T:request<T>(method,params);
  await expect(bridge.initialize('pi_bot')).rejects.toThrow('webhook');
  api.batches=[[message(10,'must not run')]];
  await expect(bridge.poll()).rejects.toThrow('游标');
  expect(host.run).not.toHaveBeenCalled();
});
it('retains a failed completion for delivery retry without re-running the agent',async()=>{
  const {api,host,events,bridge,data}=await fixture();
  const request=api.call.bind(api);let fail=true;
  api.call=async<T>(method:string,params?:Record<string,unknown>):Promise<T>=>{
    if(fail&&method==='sendMessage'&&params?.disable_notification===false)throw new Error('offline');
    return request<T>(method,params);
  };
  await bridge.handle(message(15,'task'));
  expect(host.run).toHaveBeenCalledOnce();
  expect(data.delivered).toHaveLength(0);
  const queued=await events.list();expect(queued).toHaveLength(1);
  fail=false;
  expect(await bridge.consume(queued[0])).toBe(true);
  await events.remove(queued[0].id);
  expect(await events.list()).toHaveLength(0);
  expect(host.run).toHaveBeenCalledOnce();
  expect(data.delivered).toContain(queued[0].id);
});
it('keeps permission responses tied to the allowed user, live session and exact topic',async()=>{
  const {api,host,bridge}=await fixture();let finish!:(result:TelegramTurnResult)=>void;
  vi.mocked(host.run).mockImplementation(async(_id,_text,listener:TelegramTurnListener)=>{
    listener.permission({id:'permission',request:{sessionId:'one',toolCall:{toolCallId:'t',title:'Write'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'}]}});
    return new Promise(resolve=>{finish=resolve;});
  });
  const running=bridge.handle(message(1,'permission'));
  await vi.waitFor(()=>expect(api.calls.some(c=>c.params.reply_markup)).toBe(true));
  const keyboard=api.calls.find(c=>c.params.reply_markup)!.params.reply_markup as {inline_keyboard:{callback_data:string}[][]};
  const callback=(user:number,thread:number):TelegramUpdate=>({update_id:2,callback_query:{id:'cb',from:{id:user},message:message(2,'',thread).message,data:keyboard.inline_keyboard[0][0].callback_data}});
  await bridge.handle(callback(99,101));await bridge.handle(callback(42,999));expect(host.permission).not.toHaveBeenCalled();
  await bridge.handle(callback(42,101));expect(host.permission).toHaveBeenCalledWith('one','permission','yes');
  finish({status:'completed'});await running;
  await bridge.handle(callback(42,101));expect(host.permission).toHaveBeenCalledOnce();
});
it('persists desktop completion without a running daemon and acknowledges delivery after restart',async()=>{
  const {events,bridge,api,host}=await fixture();
  const state={...initialState(),sessionId:'one',sessionNumber:1};
  state.entries.push({id:'u',role:'user',text:'desktop job'});
  const turn=new DesktopTelegramTurn(events,state,'/allowed',1,()=>{});
  applyUpdate(state,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'desktop answer'}});
  await turn.finish(undefined,'end_turn');
  await writeFile(join(events.directory,'0'.repeat(64)+'.json'),'null');
  await writeFile(join(events.directory,'1'.repeat(64)+'.json'),'{broken');
  await events.write({id:'invalid-error',sessionId:'one',cwd:'/allowed',title:'bad',text:'bad',status:'failed',updated:Date.now(),error:{} as string});
  expect(await events.list()).toHaveLength(1);
  const event=(await events.list())[0];expect(event).toMatchObject({sessionId:'one',text:'desktop answer',status:'completed'});
  expect(await bridge.consume({...event,cwd:'/forbidden'})).toBe(false);expect(api.calls).toHaveLength(0);
  expect(await bridge.consume(event)).toBe(true);
  const sent=api.calls.length;expect(await bridge.consume(event)).toBe(true);expect(api.calls).toHaveLength(sent);
  expect(host.run).not.toHaveBeenCalled();
});

it('honors explicitly paused delivery, toggles globally and synchronizes history without duplicate exports',async()=>{
 const {bridge,host,data,api,events}=await fixture();data.notifications=false;
 host.history=vi.fn(async()=>[{id:'u',role:'user' as const,text:'old question'},{id:'a',role:'assistant' as const,text:'old answer'}]);
 await bridge.handle(message(20,'new question'));
 expect(host.run).toHaveBeenCalledOnce();expect(api.calls).toHaveLength(0);expect(await events.list()).toHaveLength(0);
 await bridge.handle(message(21,'/history'));await bridge.handle(message(22,'/history'));
 expect(api.calls.filter(c=>String(c.params.text).includes('old answer'))).toHaveLength(1);
 await bridge.handle(message(23,'/notifications'));
 expect(api.calls.at(-1)?.params.reply_markup).toBeDefined();
 await bridge.handle({update_id:24,callback_query:{id:'toggle',from:{id:42},message:message(24,'').message,data:'notify:on'}});
 expect(data.notifications).toBe(true);
 await bridge.handle(message(25,'another question'));
 expect(api.calls.some(c=>c.params.text==='✅ 任务完成 · #1')).toBe(true);
 await bridge.handle({update_id:26,callback_query:{id:'bad',from:{id:99},message:message(26,'').message,data:'notify:off'}});
 expect(data.notifications).toBe(true);
});
it('serializes phone messages and discards queued messages when stopped',async()=>{
 const {bridge,host}=await fixture();let finish!:(value:TelegramTurnResult)=>void;
 vi.mocked(host.run).mockImplementationOnce(async()=>new Promise(resolve=>{finish=resolve;}));
 const first=bridge.handle(message(30,'first'));
 await vi.waitFor(()=>expect(host.run).toHaveBeenCalledOnce());
 const second=bridge.handle(message(31,'queued'));
 await bridge.handle(message(32,'/stop'));
 finish({status:'cancelled'});
 await Promise.all([first,second]);expect(host.run).toHaveBeenCalledOnce();
 await bridge.handle(message(33,'next'));expect(host.run).toHaveBeenCalledTimes(2);
 expect((bridge as any).queued.size).toBe(0);expect((bridge as any).generations.size).toBe(0);
});

it('keeps notification receipts, topic bindings and switches uncommitted when disk writes fail',async()=>{
 const {bridge,data,save,events,host,sessions}=await fixture();
 const event={id:'durable',sessionId:'one',cwd:'/allowed',title:'One',text:'answer',status:'completed' as const,updated:Date.now()};
 await events.write(event);
 save.mockRejectedValueOnce(new Error('disk full'));
 await expect(bridge.consume(event)).rejects.toThrow('disk full');
 expect(data.delivered).not.toContain(event.id);expect(await events.list()).toHaveLength(1);
 expect(await bridge.consume(event)).toBe(true);expect(data.delivered).toContain(event.id);expect(host.run).not.toHaveBeenCalled();
 save.mockRejectedValueOnce(new Error('disk full'));
 await expect(bridge.ensureTopic(sessions[1])).rejects.toThrow('disk full');
 expect(data.topics.some(t=>t.sessionId==='two')).toBe(false);
 save.mockRejectedValueOnce(new Error('disk full'));
 await expect(bridge.handle({update_id:90,callback_query:{id:'toggle',from:{id:42},message:message(90,'').message,data:'notify:off'}})).rejects.toThrow('disk full');
 expect(data.notifications).toBe(true);
});

it('reports a failed final outbox write to the session owner',async()=>{
 const {events}=await fixture();const state={...initialState(),sessionId:'one'};
 const turn=new DesktopTelegramTurn(events,state,'/allowed',0,()=>{});
 await vi.waitFor(async()=>expect(await events.list()).toHaveLength(1));
 vi.spyOn(events,'write').mockRejectedValueOnce(new Error('disk full'));
 await expect(turn.finish(undefined,'end_turn')).rejects.toThrow('disk full');
});

it('bounds and expires abandoned live notification previews',async()=>{
 vi.useFakeTimers();const {bridge}=await fixture();
 for(let i=0;i<100;i++)await bridge.consume({id:'orphan-'+i,sessionId:'one',cwd:'/allowed',title:'One',text:'x'.repeat(10000),status:'running',updated:Date.now()});
 expect((bridge as any).streams.size).toBe(32);expect((bridge as any).touched.size).toBe(32);
 vi.setSystemTime(Date.now()+6*60*1000);await vi.advanceTimersByTimeAsync(30000);
 expect((bridge as any).streams.size).toBe(0);expect((bridge as any).touched.size).toBe(0);
});

it('sync creates topics and imports history, then continues batches without duplicate messages',async()=>{
 const {bridge,host,api,data}=await fixture();data.notifications=false;
 host.history=vi.fn(async(id)=>Array.from({length:id==='one'?101:2},(_,i)=>({id:`${id}-${i}`,role:'assistant' as const,text:`history-${id}-${i}`})));
 await bridge.handle(message(301,'/sync'));
 expect(data.topics).toHaveLength(2);
 expect(api.calls.filter(c=>c.method==='createForumTopic')).toHaveLength(1);
 const histories=()=>api.calls.filter(c=>String(c.params.text).startsWith('Pi：\nhistory-'));
 expect(histories()).toHaveLength(102);
 expect(histories().every(c=>c.params.disable_notification===true)).toBe(true);
 expect(histories().filter(c=>c.params.message_thread_id===101)).toHaveLength(100);
 await bridge.handle(message(302,'/sync'));
 expect(histories()).toHaveLength(103);
 await bridge.handle(message(303,'/sync'));
 expect(histories()).toHaveLength(103);
 expect(host.run).not.toHaveBeenCalled();
});
it('sync retries history after a topic was created but sending failed',async()=>{
 const {bridge,host,api,data}=await fixture();
 host.history=vi.fn(async(id)=>id==='two'?[{id:'a',role:'assistant' as const,text:'retry-history'}]:[]);
 const call=api.call.bind(api);let fail=true;
 api.call=async<T>(method:string,params:Record<string,unknown>={}):Promise<T>=>{
  if(fail&&String(params.text).includes('retry-history')){fail=false;throw new Error('network failed');}
  return call<T>(method,params);
 };
 await bridge.handle(message(304,'/sync'));expect(data.topics).toHaveLength(2);
 await bridge.handle(message(305,'/sync'));
 expect(api.calls.filter(c=>String(c.params.text).includes('retry-history'))).toHaveLength(1);
 expect(api.calls.filter(c=>c.method==='createForumTopic')).toHaveLength(1);
});
it('help and commands list every relay command with descriptions',async()=>{
 const {bridge,api,host}=await fixture();
 await bridge.handle(message(306,'/help'));await bridge.handle(message(307,'/commands'));
 const help=api.calls.filter(c=>c.method==='sendMessage');expect(help).toHaveLength(2);expect(help[0].params.text).toBe(help[1].params.text);
 for(const command of ['new','sessions','open','sync','history','status','stop','interrupt','notifications','silent','help','commands','start'])expect(String(help[0].params.text)).toContain('/'+command);
 expect(host.run).not.toHaveBeenCalled();
});

it('delivers by default and independently persists silence without muting delivery',async()=>{
 const {bridge,data,api,host,saved,save}=await fixture();delete data.notifications;
 await bridge.handle(message(401,'default delivery'));
 expect(api.calls.some(c=>c.params.text==='✅ 任务完成 · #1'&&c.params.disable_notification===false)).toBe(true);
 const toggle=(id:number,value:string,userId=42):TelegramUpdate=>({update_id:id,callback_query:{id:String(id),from:{id:userId},message:message(id,'').message,data:value}});
 await bridge.handle(toggle(402,'silent:on'));expect(data.silent).toBe(true);expect(saved.at(-1)?.silent).toBe(true);
 api.calls=[];await bridge.handle(message(403,'quiet delivery'));
 expect(api.calls.some(c=>c.params.text==='✅ 任务完成 · #1')).toBe(true);
 expect(api.calls.filter(c=>c.method==='sendMessage').every(c=>c.params.disable_notification===true)).toBe(true);
 await bridge.handle(toggle(404,'silent:off',99));expect(data.silent).toBe(true);
 save.mockRejectedValueOnce(new Error('disk full'));
 await expect(bridge.handle(toggle(405,'silent:off'))).rejects.toThrow('disk full');expect(data.silent).toBe(true);
 await bridge.handle(toggle(406,'notify:off'));api.calls=[];await bridge.handle(message(407,'paused'));
 expect(api.calls).toHaveLength(0);expect(host.run).toHaveBeenCalledTimes(3);
 await bridge.handle(toggle(408,'silent:off'));expect(data.notifications).toBe(false);expect(data.silent).toBe(false);
});
it('applies the live silence setting to completion of an existing stream',async()=>{
 const api=new FakeApi();let silent=false;
 const stream=new TelegramStream(api,-100,101,1,()=>{},()=>true,()=>silent);
 stream.update('preview');await new Promise(r=>setTimeout(r,10));silent=true;
 await stream.finish('final','complete');expect(api.calls.at(-1)?.params.disable_notification).toBe(true);
});

it('includes desktop input before the reply and does not duplicate it on event redelivery',async()=>{
 const {bridge,api}=await fixture();
 const event={id:'with-input',sessionId:'one',cwd:'/allowed',title:'One',inputText:'desktop question',text:'agent answer',status:'completed' as const,updated:Date.now()};
 expect(await bridge.consume(event)).toBe(true);
 const replies=api.calls.filter(c=>String(c.params.text).includes('desktop question'));
 expect(replies).toHaveLength(1);expect(replies[0].params.text).toBe('你（VS Code）：\ndesktop question\n\nPi：\nagent answer');
 const count=api.calls.length;expect(await bridge.consume(event)).toBe(true);expect(api.calls).toHaveLength(count);
 await bridge.consume({...event,id:'phone',inputText:undefined,text:'phone answer'});
 expect(api.calls.filter(c=>String(c.params.text).includes('desktop question'))).toHaveLength(1);
 expect(api.calls.some(c=>c.params.text==='phone answer')).toBe(true);
});
