export interface TelegramConfig {
  chatId:number;allowedUserIds:number[];workspaces:Record<string,string>;maxConcurrent:number;
  command?:string;args:string[];env:Record<string,string>;
}
export function telegramConfig(value:unknown):TelegramConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Telegram 配置必须为 JSON 对象。');
  const v=value as Record<string,unknown>;
  if(!Number.isSafeInteger(v.chatId)||Number(v.chatId)>=0)throw new Error('chatId 必须是私人 Topics 超级群组的负整数 ID。');
  if(!Array.isArray(v.allowedUserIds)||!v.allowedUserIds.length||v.allowedUserIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。');
  if(!v.workspaces||typeof v.workspaces!=='object'||Array.isArray(v.workspaces)||!Object.keys(v.workspaces).length||Object.entries(v.workspaces).some(([name,path])=>!/^[-\w]+$/.test(name)||['__proto__','constructor','prototype'].includes(name)||typeof path!=='string'||!path.trim()))throw new Error('workspaces 必须是工作区名称到本机目录的非空映射。');
  const maxConcurrent=v.maxConcurrent??3;
  if(!Number.isInteger(maxConcurrent)||Number(maxConcurrent)<1||Number(maxConcurrent)>8)throw new Error('maxConcurrent 必须在 1–8 之间。');
  if(v.command!==undefined&&(typeof v.command!=='string'||!v.command.trim()))throw new Error('command 必须是可执行文件路径。');
  if(v.args!==undefined&&(!Array.isArray(v.args)||v.args.some(a=>typeof a!=='string')))throw new Error('args 必须是字符串数组。');
  if(v.env!==undefined&&(!v.env||typeof v.env!=='object'||Array.isArray(v.env)||Object.values(v.env).some(e=>typeof e!=='string')))throw new Error('env 必须是字符串环境变量映射。');
  return {chatId:Number(v.chatId),allowedUserIds:v.allowedUserIds as number[],workspaces:v.workspaces as Record<string,string>,
    maxConcurrent:Number(maxConcurrent),command:v.command as string|undefined,args:v.args as string[]||[],env:v.env as Record<string,string>||{}};
}
