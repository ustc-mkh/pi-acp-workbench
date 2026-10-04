import type * as acp from '@agentclientprotocol/sdk';
import type {ChatState,Snapshot} from './shared';
import {checkPromptSize} from './context';

export interface ServiceConfig {command:string;args:string[];env?:Record<string,string>;maxWorkers:number;idleMs:number}
export interface ServiceState {snapshot:Snapshot;busy:boolean;permissions:ChatState['permissions'];commands:ChatState['commands'];error?:string}
export const AGENT_METHODS=['_pi_workbench/inspect','_pi_workbench/fork','_pi_workbench/cancel_fork','session/set_mode','session/set_config_option'] as const;
export type AgentMethod=typeof AGENT_METHODS[number];
export type ServiceCommand=
  | {kind:'hello'|'list'}
  | {kind:'create';cwd:string}
  | {kind:'state'|'cancel'|'remove';sessionId:string}
  | {kind:'permission';sessionId:string;permissionId:string;optionId?:string}
  | {kind:'prompt';sessionId:string;prompt:acp.ContentBlock[];source:'desktop'|'telegram'}
  | {kind:'request';sessionId:string;method:AgentMethod;params:Record<string,unknown>};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function text(value:unknown,name:string):string {
  if(typeof value!=='string'||!value||value.length>10000)throw new Error(`无效参数：${name}`);
  return value;
}
/** One validation boundary for both UI clients; no old command names or payload translation. */
export function serviceCommand(method:string,params:unknown):ServiceCommand {
  if(!object(params))throw new Error('服务参数必须是对象');
  if(method==='hello'||method==='list')return {kind:method};
  if(method==='create')return {kind:method,cwd:text(params.cwd,'cwd')};
  const sessionId=text(params.sessionId,'sessionId');
  if(method==='state'||method==='cancel'||method==='remove')return {kind:method,sessionId};
  if(method==='permission')return {kind:method,sessionId,permissionId:text(params.permissionId,'permissionId'),optionId:params.optionId===undefined?undefined:text(params.optionId,'optionId')};
  if(method==='prompt') {
    if(!Array.isArray(params.prompt)||!params.prompt.length||!params.prompt.every(block=>object(block)&&typeof block.type==='string'))throw new Error('消息格式无效');
    checkPromptSize(params.prompt as acp.ContentBlock[]);
    if(params.source!==undefined&&params.source!=='desktop'&&params.source!=='telegram')throw new Error('消息来源无效');
    return {kind:method,sessionId,prompt:params.prompt as acp.ContentBlock[],source:params.source||'desktop'};
  }
  if(method==='request') {
    if(!AGENT_METHODS.includes(params.method as AgentMethod))throw new Error('不支持的 ACP 操作');
    const args=params.params===undefined?{}:params.params;
    if(!object(args))throw new Error('ACP 参数必须是对象');
    if(params.method==='session/set_mode')text(args.modeId,'modeId');
    if(params.method==='session/set_config_option'){text(args.configId,'configId');text(args.value,'value');}
    if(params.method==='_pi_workbench/fork'){text(args.entryId,'entryId');text(args.hash,'hash');}
    return {kind:method,sessionId,method:params.method as AgentMethod,params:args};
  }
  throw new Error('未知服务操作');
}
export function durableCommand(command:ServiceCommand):boolean {
  return command.kind==='create'||command.kind==='prompt'||command.kind==='request'&&['_pi_workbench/fork','session/set_mode','session/set_config_option'].includes(command.method);
}
