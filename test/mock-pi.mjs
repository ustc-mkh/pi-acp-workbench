#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
const summary=process.argv.includes('--no-tools'),sid=randomUUID(),file=join(process.cwd(),sid+'.jsonl');
const model={provider:'anthropic',id:'claude-sonnet-4-6',name:'Claude Sonnet 4.6',contextWindow:200000,maxTokens:8192,reasoning:true,input:['text'],api:'anthropic-messages',cost:{input:3,output:15,cacheRead:.3,cacheWrite:3.75}};
let messages=[],thinking='off';
writeFileSync(file,JSON.stringify({type:'session',id:sid,timestamp:new Date().toISOString(),cwd:process.cwd()})+'\n');
if(process.env.PI_TEST_AUDIT)appendFileSync(process.env.PI_TEST_AUDIT,JSON.stringify({argv:process.argv.slice(2),pid:process.pid})+'\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const append=e=>appendFileSync(file,JSON.stringify({...e,id:randomUUID(),timestamp:new Date().toISOString()})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const cmd=JSON.parse(line),reply=data=>send({type:'response',id:cmd.id,command:cmd.type,success:true,data});
 switch(cmd.type){
 case 'get_state':reply({sessionId:sid,sessionFile:file,model,thinkingLevel:thinking,isStreaming:false});break;
 case 'get_available_models':reply({models:[model]});break;
 case 'get_available_thinking_levels':reply({levels:['off','low','high']});break;
 case 'set_thinking_level':thinking=cmd.level;reply({});break;
 case 'set_model':reply(model);break;
 case 'get_commands':reply({commands:[]});break;
 case 'get_messages':reply({messages});break;
 case 'get_session_stats':reply({tokens:{input:100,output:20,cacheRead:800,cacheWrite:100,total:1020},contextUsage:{tokens:1020,contextWindow:200000,percent:.51},cost:.01});break;
 case 'abort':reply({});send({type:'agent_end',messages});send({type:'agent_settled'});break;
 case 'prompt':{
  reply({});if(summary&&cmd.message.includes('WAIT_FOREVER'))break;
  if(cmd.message==='MODEL_ERROR'){
   const message={role:'assistant',content:[],stopReason:'error',errorMessage:'<html><body>Unable to load site</body></html>'};
   send({type:'message_end',message});send({type:'auto_retry_end',success:false});send({type:'agent_end',messages:[message]});send({type:'agent_settled'});break;
  }
  const message={role:'assistant',provider:model.provider,model:model.id,api:model.api,content:[{type:'text',text:summary?'保留目标、约束与待办。':'完成，公式 $x^2$。'}],usage:{input:100,output:20,cacheRead:800,cacheWrite:100,cost:{total:.001}},timestamp:Date.now(),stopReason:'stop'};
  messages.push({role:'user',content:cmd.message},message);append({type:'message',message});
  if(!summary){const compaction={type:'compaction',summary:'压缩后的历史摘要',firstKeptEntryId:'kept',usage:{input:50,output:10,cacheRead:0,cacheWrite:0,cost:{total:.0003}}};append(compaction);messages=[{role:'compactionSummary',summary:compaction.summary},message];}
  send({type:'agent_start'});send({type:'message_start',message:{...message,content:[]}});send({type:'message_update',message,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:message.content[0].text}});send({type:'message_end',message});send({type:'turn_end',message,toolResults:[]});send({type:'agent_end',messages});send({type:'agent_settled'});break;
 }
 default:reply({});
 }
});
