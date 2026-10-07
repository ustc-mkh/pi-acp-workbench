export interface TelegramConfig {
  chatId:number;allowedUserIds:number[];workspaces:Record<string,string>;restrictToWorkspaces?:boolean;
}
export function telegramConfig(value:unknown):TelegramConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Telegram 配置必须为 JSON 对象。');
  const v=value as Record<string,unknown>;
  if(!Number.isSafeInteger(v.chatId)||Number(v.chatId)>=0)throw new Error('chatId 必须是私人 Topics 超级群组的负整数 ID。');
  if(!Array.isArray(v.allowedUserIds)||!v.allowedUserIds.length||v.allowedUserIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('allowedUserIds 必须包含至少一个明确允许的 Telegram 用户数字 ID。');
  const workspaces=v.workspaces??{};
  if(!workspaces||typeof workspaces!=='object'||Array.isArray(workspaces)||Object.entries(workspaces).some(([name,path])=>!/^[-\w]+$/.test(name)||['__proto__','constructor','prototype'].includes(name)||typeof path!=='string'||!path.trim()))throw new Error('workspaces 必须是工作区名称到本机目录的映射。');
  if(v.restrictToWorkspaces!==undefined&&typeof v.restrictToWorkspaces!=='boolean')throw new Error('restrictToWorkspaces 必须是布尔值。');
  const unsupported=Object.keys(v).filter(key=>!['chatId','allowedUserIds','workspaces','restrictToWorkspaces'].includes(key));
  if(unsupported.length)throw new Error(`不支持的 Telegram 配置字段：${unsupported.join(', ')}`);
  return {chatId:Number(v.chatId),allowedUserIds:v.allowedUserIds as number[],workspaces:workspaces as Record<string,string>,...(v.restrictToWorkspaces===undefined?{}:{restrictToWorkspaces:v.restrictToWorkspaces as boolean})};
}
