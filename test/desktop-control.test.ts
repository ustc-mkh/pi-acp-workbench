import {it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopClient,DesktopServer,DesktopUnavailable} from '../src/desktop-control';
import {TelegramRouting} from '../src/telegram-routing';
import type {TelegramSessionHost} from '../src/telegram-sessions';

it('routes to an existing desktop owner, falls back only before dispatch and never replays a disconnected request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-ipc-'));
 const client=new DesktopClient(root);
 const local:TelegramSessionHost={list:async()=>[{id:'one',cwd:'/allowed',title:'One'}],create:vi.fn(),run:vi.fn(async()=>({text:'local',status:'completed' as const})),cancel:async()=>false,permission:()=>false,dispose:async()=>{}};
 const router=new TelegramRouting(local,client);
 let calls=0,hang=false;
 const server=new DesktopServer(async(request,event)=>{
  if(request.action==='status')return {};
  calls++;event({kind:'update',value:'stream'});
  if(hang)return new Promise(()=>{});
  return {text:'desktop',status:'completed'};
 },()=>{},root);
 try {
  await expect(client.request({sessionId:'one',action:'status'})).rejects.toBeInstanceOf(DesktopUnavailable);
  expect((await router.run('one','fallback',{update:()=>{},permission:()=>{}})).text).toBe('local');
  server.bind('one');await vi.waitFor(async()=>expect(await client.request({sessionId:'one',action:'status'})).toEqual({}));
  const update=vi.fn();expect((await router.run('one','desktop',{update,permission:()=>{}})).text).toBe('desktop');
  expect(update).toHaveBeenCalledWith('stream');expect(local.run).toHaveBeenCalledOnce();
  hang=true;
  const pending=router.run('one','never replay',{update:()=>{},permission:()=>{}});const rejected=expect(pending).rejects.toThrow('不会自动重发');
  await vi.waitFor(()=>expect(calls).toBe(2));await server.dispose();await rejected;
  expect(local.run).toHaveBeenCalledOnce();
  await expect(router.run('forbidden','x',{update:()=>{},permission:()=>{}})).rejects.toThrow('允许');
 }finally{await server.dispose();await router.dispose();await rm(root,{recursive:true,force:true});}
});
