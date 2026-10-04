export interface TelegramConfig {
  chatId:number;allowedUserIds:number[];workspaces:Record<string,string>;
}
export function telegramConfig(value:unknown):TelegramConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Telegram 配置必须为 JSON 对象。');
  const v=value as Record<string,unknown>;
  if(!Number.isSafeInteger(v.chatId)||Number(v.chatId)>=0)throw new Error('chatId 必须是私人 Topics 超级群组的负整数 ID。');
  if(!Array.isArray(v.allowedUserIds)||!v.allowedUserIds.length||v.allowedUserIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。');
  const workspaces=v.workspaces??{};
  if(!workspaces||typeof workspaces!=='object'||Array.isArray(workspaces)||Object.entries(workspaces).some(([name,path])=>!/^[-\w]+$/.test(name)||['__proto__','constructor','prototype'].includes(name)||typeof path!=='string'||!path.trim()))throw new Error('workspaces 必须是工作区名称到本机目录的映射。');
  if(['command','args','env','maxConcurrent'].some(key=>key in v))throw new Error('请将 command/args/env 移到 sessions.json，并将 maxConcurrent 改为 maxWorkers；Telegram 仅保留接入配置。');
  return {chatId:Number(v.chatId),allowedUserIds:v.allowedUserIds as number[],workspaces:workspaces as Record<string,string>};
}
