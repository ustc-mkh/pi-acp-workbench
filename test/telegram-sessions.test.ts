import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,mkdir,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentProcess} from '../src/agent';
import {SessionService} from '../src/session-service';
import {SessionServer,SessionClient} from '../src/session-wire';
import {TelegramSessions} from '../src/telegram-sessions';
import {RemoteAgent} from '../src/remote-agent';
import {createHash} from 'node:crypto';
import {writeTelegramJson,TelegramEvents} from '../src/telegram-events';
const cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(maxWorkers=2,idleMs=900000,mode='context'){
 const root=await mkdtemp(join(tmpdir(),'pi-service-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const socket=join(root,'service','sessions.sock'),audit=join(root,'audit.jsonl');
 let server:SessionServer;const agents:AgentProcess[]=[];
 const service=new SessionService(root,{command:process.execPath,args:[resolve('test/mock-agent.mjs'),mode],env:{PI_TEST_AUDIT:audit},maxWorkers,idleMs},event=>server.broadcast(event),()=>{},options=>{const agent=new AgentProcess(options);agents.push(agent);return agent;});
 await service.initialize();server=new SessionServer(socket,(m,p,id)=>service.handle(m,p,id));await server.listen();cleanup.push(()=>service.dispose());cleanup.push(()=>server.dispose());
 const host=new TelegramSessions({test:root},socket);cleanup.push(()=>host.dispose());const client=new SessionClient(socket);cleanup.push(()=>client.dispose());
 return {root,service,server,host,client,socket,audit,agents};
}
it('shares a running task between desktop and phone; detaching desktop does not kill Pi',async()=>{
 const {root,host,socket,client}=await fixture();
 const state=vi.fn(),agent=new RemoteAgent({cwd:root,command:'unused',args:[],update:()=>{},permission:vi.fn(),closed:()=>{},log:()=>{}},state,socket);cleanup.push(()=>agent.dispose());
 await agent.initialize();const session=await agent.createSession();
 const pending=agent.prompt(session.sessionId,[{type:'text',text:'wait'}]);const rejected=expect(pending).rejects.toThrow('不会自动重发');
 await vi.waitFor(async()=>expect((await host.control(session.sessionId,'status')).busy).toBe(true));agent.dispose();await rejected;
 expect((await host.control(session.sessionId,'status')).busy).toBe(true);
 await host.cancel(session.sessionId);
 await vi.waitFor(async()=>expect((await host.control(session.sessionId,'status')).busy).toBe(false));
 const result=await host.run(session.sessionId,'中文😀',{update:()=>{},permission:()=>{}});expect(result.status).toBe('completed');
 expect((await host.history(session.sessionId)).some(e=>'text'in e&&e.text==='中文😀')).toBe(true);
 await expect(client.call('create',{cwd:'/forbidden'})).rejects.toThrow();
},15000);
it('deduplicates requests, serializes a session, bounds workers, and reclaims idle Pi',async()=>{
 const {host,client,service,audit,agents}=await fixture(1,1000);const a=await host.create(),b=await host.create();
 const first=client.call('prompt',{sessionId:a.id,prompt:[{type:'text',text:'wait'}]},'once',0);
 await vi.waitFor(async()=>expect((await readFile(audit,'utf8')).includes('"text":"wait"')).toBe(true));
 const queued=client.call('prompt',{sessionId:b.id,prompt:[{type:'text',text:'second'}]},'second',0);
 const duplicate=service.handle('prompt',{sessionId:a.id,prompt:[{type:'text',text:'wait'}]},'once');
 await host.cancel(a.id);await first;await duplicate;await queued;
 const wire=await readFile(audit,'utf8');expect(wire.split('\n').filter(l=>l.includes('session/prompt')&&l.includes('"text":"wait"'))).toHaveLength(1);
 expect((service as any).runtimes.size).toBeLessThanOrEqual(1);
 await vi.waitFor(()=>expect((service as any).runtimes.size).toBe(0),{timeout:6000});
 for(const agent of agents){const pid=(agent as any).child.pid;if(pid)expect(()=>process.kill(pid,0)).toThrow();}
 const before=await readFile(audit,'utf8');await client.call('state',{sessionId:a.id});expect(await readFile(audit,'utf8')).toBe(before);
},20000);
it('shares permission tickets and accepts only the first valid response',async()=>{
 const {host,client}=await fixture();const session=await host.create();let permission:any;
 const turn=host.run(session.id,'permission',{update:()=>{},permission:p=>{permission=p;}});
 await vi.waitFor(()=>expect(permission).toBeDefined());
 expect(await host.permission(session.id,permission.id,'invalid')).toBe(false);
 const option=permission.request.options[0].optionId;
 expect(await client.call('permission',{sessionId:session.id,permissionId:permission.id,optionId:option})).toBe(true);
 expect(await host.permission(session.id,permission.id,option)).toBe(false);await turn;
},15000);

it('marks unfinished durable requests interrupted on restart without re-running tools',async()=>{
 const {root,host,audit}=await fixture();const session=await host.create();
 const id='interrupted-request';await writeTelegramJson(join(root,'service','requests',createHash('sha256').update(id).digest('hex')+'.json'),{id,sessionId:session.id,status:'running'});
 const recovered=new SessionService(root,{command:process.execPath,args:[resolve('test/mock-agent.mjs'),'context'],maxWorkers:1,idleMs:900000},()=>{},()=>{});cleanup.push(()=>recovered.dispose());
 const before=await readFile(audit,'utf8');await recovered.initialize();
 await expect(recovered.handle('prompt',{sessionId:session.id,prompt:[{type:'text',text:'never repeat'}]},id)).rejects.toThrow('不会自动重放');
 expect(await readFile(audit,'utf8')).toBe(before);
 expect((await new TelegramEvents(join(root,'telegram','events')).list())[0]).toMatchObject({status:'failed',sessionId:session.id});
},10000);
it('loads native fork settings, preserves source history and leaves separate durable sessions',async()=>{
 const {host,client}=await fixture(1,900000,'context-native');const session=await host.create();
 await host.run(session.id,'first',{update:()=>{},permission:()=>{}});
 const inspection:any=await client.call('request',{sessionId:session.id,method:'_pi_workbench/inspect',params:{force:true}},undefined,0);
 await client.call('request',{sessionId:session.id,method:'session/set_config_option',params:{configId:'model',value:'other'}},undefined,0);
 const point=inspection.forkPoints.find((p:any)=>p.role==='assistant');
 const fork:any=await client.call('request',{sessionId:session.id,method:'_pi_workbench/fork',params:point},undefined,0);
 const state:any=await client.call('state',{sessionId:fork.sessionId});expect(state.snapshot.configs[0].currentValue).toBe('default');
 expect((await host.list())).toHaveLength(2);expect((await host.history(session.id)).some(e=>'text'in e&&e.text==='first')).toBe(true);
},15000);

it('never dispatches a prompt if saving its user message fails, and never retries that request ID',async()=>{
 const {host,service,audit}=await fixture();const session=await host.create();
 const store=(service as any).store;const save=vi.spyOn(store,'write').mockRejectedValueOnce(new Error('disk full'));
 const params={sessionId:session.id,prompt:[{type:'text',text:'must not execute'}]};
 await expect(service.handle('prompt',params,'disk-failure')).rejects.toThrow('disk full');save.mockRestore();
 await expect(service.handle('prompt',params,'disk-failure')).rejects.toThrow('不会自动重放');
 expect((await readFile(audit,'utf8')).includes('"method":"session/prompt"')).toBe(false);
},10000);

it('uses arbitrary directories from desktop and Telegram without workspace registration',async()=>{
 const {root,client,host}=await fixture();
 const directory=join(root,'unlisted project'),alias=join(root,'project-link'),file=join(root,'file');
 await mkdir(directory);await symlink(directory,alias);await writeFile(file,'not a directory');
 const desktop:any=await client.call('create',{cwd:alias});expect(desktop.cwd).toBe(directory);
 expect((await host.list()).some(s=>s.id===desktop.id)).toBe(true);
 expect((await host.run(desktop.id,'hello',{update:()=>{},permission:()=>{}})).status).toBe('completed');
 expect((await host.history(desktop.id)).some(e=>'text'in e&&e.text==='hello')).toBe(true);
 expect((await new TelegramEvents(join(root,'telegram','events')).list())[0].inputText).toBeUndefined();
 await client.call('prompt',{sessionId:desktop.id,prompt:[{type:'text',text:'desktop input'}]});
 expect((await new TelegramEvents(join(root,'telegram','events')).list()).some(e=>e.inputText==='desktop input')).toBe(true);
 const phone=await host.create(directory);expect(phone.cwd).toBe(directory);
 await expect(host.create(file)).rejects.toThrow('工作区不是目录');
 await expect(client.call('create',{cwd:'relative'})).rejects.toThrow('绝对目录路径');
 await expect(client.call('create',{cwd:join(root,'missing')})).rejects.toThrow();
},15000);
