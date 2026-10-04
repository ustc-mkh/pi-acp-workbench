import { readFile, mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { TelegramApi } from './telegram-api';
import { TelegramBridge, type TelegramBridgeState } from './telegram-bridge';
import { TelegramSessions } from './telegram-sessions';
import { telegramConfig } from './telegram-config';
import { TelegramEvents, writeTelegramJson } from './telegram-events';
import { SharedHistoryStore } from './shared-history';

async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')){
    console.log('Usage: PI_TELEGRAM_BOT_TOKEN=... node dist/telegram-daemon.mjs --config /path/telegram.json\nOptional: --data-dir /path/pi-acp-workbench (default ~/.pi/pi-acp-workbench)');return;
  }
  const token=process.env.PI_TELEGRAM_BOT_TOKEN;
  if(!token||!/^\d+:[\w-]{20,}$/.test(token))throw new Error('请通过 PI_TELEGRAM_BOT_TOKEN 环境变量提供 BotFather token，不要放入项目配置或命令参数。');
  if(args.includes('--discover')){
    const api=new TelegramApi(token);
    try {
      const updates=await api.call<import('./telegram-api').TelegramUpdate[]>('getUpdates',{timeout:20,allowed_updates:['message']});
      for(const update of updates)if(update.message)console.log(JSON.stringify({chatId:update.message.chat.id,userId:update.message.from?.id,threadId:update.message.message_thread_id}));
    } finally {api.dispose();}
    return;
  }
  const configIndex=args.indexOf('--config');
  if(configIndex<0||!args[configIndex+1])throw new Error('需要 --config /absolute/path/telegram.json；示例见 docs/telegram.md。');
  const config=telegramConfig(JSON.parse(await readFile(resolve(args[configIndex+1]),'utf8')));
  for(const [name,path]of Object.entries(config.workspaces)){
    if(!isAbsolute(path))throw new Error(`工作区 ${name} 必须使用绝对路径。`);
    config.workspaces[name]=await realpath(path);
    if(!(await stat(config.workspaces[name])).isDirectory())throw new Error(`工作区 ${name} 不是目录。`);
  }
  const dataIndex=args.indexOf('--data-dir');
  if(dataIndex>=0&&(!args[dataIndex+1]||args[dataIndex+1].startsWith('--')))throw new Error('--data-dir 需要目录路径。');
  const root=dataIndex<0?join(homedir(),'.pi','pi-acp-workbench'):resolve(args[dataIndex+1]);
  const directory=join(root,'telegram');await mkdir(directory,{recursive:true,mode:0o700});
  const api=new TelegramApi(token);
  const report=(error:unknown)=>console.error(`[telegram] ${(error instanceof Error?error.message:String(error)).split(token).join('[redacted]')}`);
  let relay:TelegramBridge|undefined,host:TelegramSessions|undefined,release:(()=>Promise<void>)|undefined;
  let compromised=false,stopping=false;
  const abort=new AbortController();
  const stop=()=>{
    if(stopping)return;
    stopping=true;abort.abort();api.dispose();
    void (relay?relay.dispose():host?.dispose())?.catch(report);
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const bot=await api.call<{id:number;username:string}>('getMe');
    release=await lock(join(directory,`bot-${bot.id}`),{realpath:false,stale:30000,update:10000,retries:0,
      onCompromised:error=>{compromised=true;report(error);stop();}});
    const file=join(directory,`bot-${bot.id}-chat-${config.chatId}.json`);
    let state:TelegramBridgeState={version:1,botId:bot.id,chatId:config.chatId,topics:[],delivered:[]};
    try {
      state=JSON.parse(await readFile(file,'utf8'));
      if(state.version!==1||state.botId!==bot.id||state.chatId!==config.chatId||!Array.isArray(state.topics)||!Array.isArray(state.delivered)||state.delivered.some(id=>typeof id!=='string')||state.topics.some(t=>typeof t.sessionId!=='string'||!Number.isSafeInteger(t.threadId)||t.threadId<=0)||state.offset!==undefined&&(!Number.isSafeInteger(state.offset)||state.offset<0))throw new Error('Telegram 绑定文件无效，请从备份恢复；不会自动重新执行旧任务。');
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const store=new SharedHistoryStore(join(root,'history'),id=>host?.leaseLost(id));
    host=new TelegramSessions(store,{...config,command:config.command||process.execPath,
      args:config.command?config.args:[fileURLToPath(new URL('./pi-adapter.mjs',import.meta.url))],
      env:{...config.env,...(!config.command?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
    const events=new TelegramEvents(join(directory,'events'));
    relay=new TelegramBridge(api,host,events,state,{...config,save:s=>writeTelegramJson(file,s),report});
    await relay.initialize(bot.username);
    console.log(`Telegram relay ready: @${bot.username}, ${Object.keys(config.workspaces).join(', ')}; send /help in the configured Topics group.`);
    const poll=relay.poll();
    const sweep=(async()=>{
      while(!stopping){
        try {for(const event of await events.list()){if(stopping)break;if(await relay!.consume(event))await events.remove(event.id);}}
        catch(error){if(!stopping)report(error);}
        await delay(2500,undefined,{signal:abort.signal}).catch(()=>{});
      }
    })();
    try {await poll;} finally {stop();await relay.dispose();await sweep;await store.releaseAll();}
  } finally {
    stop();await relay?.dispose();
    if(release&&!compromised)await release();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
main().catch(error=>{
  const message=error instanceof Error?error.message:'Telegram 启动失败。';
  console.error(process.env.PI_TELEGRAM_BOT_TOKEN?message.split(process.env.PI_TELEGRAM_BOT_TOKEN).join('[redacted]'):message);
  process.exitCode=1;
});
