import {it,expect,beforeAll} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AgentProcess} from '../src/agent';
import type {Inspection} from '../src/telemetry';
beforeAll(()=>{execFileSync(process.execPath,['--input-type=module','-e',"import {buildAdapter} from './scripts/build-adapter.mjs'; await buildAdapter();"],{cwd:process.cwd(),stdio:'pipe'});});
it('negotiates real bundled ACP extensions, reads native billing/checkpoints, and isolates cancellable summary workers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-adapter-test-'));let agent:AgentProcess|undefined;
 try{
  await mkdir(join(dir,'.pi'));await writeFile(join(dir,'.pi/settings.json'),'{"quietStartup":true}');
  agent=new AgentProcess({command:process.execPath,args:[resolve('dist/pi-adapter.mjs')],cwd:dir,env:{PI_ACP_PI_COMMAND:resolve('test/mock-pi.mjs'),PI_ACP_WORKBENCH_STATE_DIR:join(dir,'adapter-state'),PI_CODING_AGENT_DIR:join(dir,'pi-data'),PI_TEST_AUDIT:join(dir,'audit.jsonl')},update:()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),closed:()=>{},log:()=>{},requestTimeoutMs:5000});
  const info=await agent.initialize();expect(info.agentCapabilities?._meta?.['pi-workbench']).toMatchObject({version:1});
  const {sessionId}=await agent.createSession();
  expect(await agent.prompt(sessionId,[{type:'text',text:'test'}])).toMatchObject({stopReason:'end_turn'});
  const inspect=()=>agent!.connection.agent.request<Inspection>('_pi_workbench/inspect',{sessionId});
  const data=await inspect();expect(data.records).toHaveLength(2);expect(data.records.map(r=>r.kind)).toEqual(['inference','compaction']);expect(data.records[0]).toMatchObject({cacheRead:800,input:100,cacheWrite:100,output:20});expect(data.context).toContain('压缩后的历史摘要');expect(data.contextWindow).toBe(200000);
  expect((await inspect()).records.map(r=>r.id)).toEqual(data.records.map(r=>r.id));
  const result=await agent.connection.agent.request<any>('_pi_workbench/summarize',{sessionId,text:'historical data',limit:1000});expect(result.text).toContain('保留目标');expect(result.records).toHaveLength(1);
  const launches=(await readFile(join(dir,'audit.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(launches[1].argv).toEqual(expect.arrayContaining(['--no-tools','--no-extensions','--no-skills','--no-session','--no-prompt-templates']));
  const pending=agent.connection.agent.request('_pi_workbench/summarize',{sessionId,text:'WAIT_FOREVER',limit:1000});const rejected=expect(pending).rejects.toThrow();
  await new Promise(resolve=>setTimeout(resolve,100));await agent.connection.agent.request('_pi_workbench/cancel_summary',{sessionId});await rejected;
  expect((await inspect()).records).toHaveLength(3);
  await expect(agent.prompt(sessionId,[{type:'text',text:'MODEL_ERROR'}])).rejects.toThrow('模型服务返回网页错误');
  expect(await agent.prompt(sessionId,[{type:'text',text:'recovered'}])).toMatchObject({stopReason:'end_turn'});
 }finally{agent?.dispose();await rm(dir,{recursive:true,force:true});}
},20000);
