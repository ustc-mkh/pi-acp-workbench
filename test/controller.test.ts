import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const host = vi.hoisted(() => ({ provider: undefined as any, config: {} as Record<string, unknown>, stored: new Map<string, unknown>(), commands: new Map<string, Function>(), updates: [] as unknown[], configurationChanged: undefined as undefined | ((event: any) => void), home: undefined as string | undefined, terminals: [] as any[] }));
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return {...os,homedir:()=>host.home || os.homedir()};
});
vi.mock('vscode', () => ({
  Uri: {from: (parts: {scheme:string;path:string}) => ({toString: () => `${parts.scheme}:${parts.path}`})},
  env:{clipboard:{writeText:vi.fn(async()=>{})}},
  workspace: {
    isTrusted: true,
    get workspaceFolders() { return [{ uri: { scheme: 'file', fsPath: process.cwd() } }]; },
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => host.config[key] ?? fallback }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeConfiguration: (callback: (event: any) => void) => { host.configurationChanged = callback; return { dispose() {} }; },
  },
  window: {
    createTerminal: (options:any) => {host.terminals.push(options);return {show(){}};},
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: (_: string, provider: unknown) => { host.provider = provider; return { dispose() {} }; },
  },
  commands: {
    registerCommand: (name: string, fn: Function) => { host.commands.set(name, fn); return { dispose() {} }; },
    executeCommand: async () => {},
  },
}));
import { activate } from '../src/extension';
let context: any;
beforeEach(() => {
  host.config = { sharedHistory: false, command: process.execPath, args: [resolve('test/mock-agent.mjs')] }; host.stored.clear(); host.terminals = [];
  context = { subscriptions: [], workspaceState: { get: (key: string, fallback: unknown) => host.stored.has(key) ? host.stored.get(key) : fallback, update: async (key: string, value: unknown) => host.stored.set(key, structuredClone(value)) } };
  activate(context);
});
afterEach(() => { context.subscriptions.forEach((d: { dispose(): void }) => d.dispose()); });
function mockHarness(harness:'codex'|'claude',mode='') {
  host.config[harness+'.command']=process.execPath;
  host.config[harness+'.args']=[resolve('test/mock-agent.mjs'),mode];
}
it('switches harness without auto-creating a session and isolates identical IDs, histories and attachments',async()=>{
  mockHarness('codex');mockHarness('claude');
  await host.provider.perform({type:'new'});await host.provider.perform({type:'send',text:'Pi only'});
  host.provider.state.attachments=[{id:'private',name:'Pi context',uri:'file:///private',text:'do not transfer'}];
  const pi=host.provider.snapshot();const create=vi.spyOn(host.provider,'createAgent');create.mockClear();
  await host.provider.perform({type:'switchHarness',harness:'codex'});
  expect(create).not.toHaveBeenCalled();expect(host.provider.snapshot()).toMatchObject({harness:'codex',status:'disconnected',entries:[],attachments:[]});
  await host.provider.perform({type:'new'});await host.provider.perform({type:'send',text:'Codex only'});
  const codex=host.provider.snapshot();expect(codex.sessionId).toBe('workbench:codex:test-session');
  await host.provider.perform({type:'switchHarness',harness:'claude'});await host.provider.perform({type:'new'});await host.provider.perform({type:'send',text:'Claude only'});
  expect(host.provider.snapshot().sessionId).toBe('workbench:claude:test-session');
  expect(new Set(host.provider.history.map((s:any)=>s.id)).size).toBe(3);
  expect(host.provider.history.map((s:any)=>s.harness).sort()).toEqual(['claude','codex','pi']);
  await host.provider.perform({type:'resume',id:pi.sessionId});
  expect(host.provider.snapshot()).toMatchObject({harness:'pi',sessionId:pi.sessionId,status:'ready'});
  expect(host.provider.snapshot().attachments).toEqual([{id:'private',name:'Pi context',uri:'file:///private',text:'do not transfer'}]);
  expect(host.provider.snapshot().entries.some((e:any)=>e.text==='Codex only')).toBe(false);
  expect(host.stored.get('activeSession')).toBe(pi.sessionId);
  expect(host.stored.get('harness.codex.activeSession')).toBe(codex.sessionId);
});
it('keeps model preferences separate and rejects switching during an active prompt',async()=>{
  await contextAgent();await host.provider.perform({type:'config',id:'model',value:'other'});
  mockHarness('codex','context');await host.provider.perform({type:'switchHarness',harness:'codex'});await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().configs.find((c:any)=>c.id==='model').currentValue).toBe('default');
  await host.provider.perform({type:'config',id:'thinking',value:'high'});
  expect(host.stored.get('sessionPreferences')).not.toEqual(host.stored.get('harness.codex.sessionPreferences'));
  const turn=host.provider.perform({type:'send',text:'wait'});await vi.waitFor(()=>expect(host.provider.snapshot().status).toBe('busy'));
  await host.provider.perform({type:'switchHarness',harness:'claude'});expect(host.provider.snapshot().harness).toBe('codex');
  await host.provider.perform({type:'cancel'});await turn;
  const id=host.provider.snapshot().sessionId;await host.provider.perform({type:'branchMessage',sessionId:id,id:host.provider.snapshot().entries[0].id});
  expect(host.provider.snapshot().error).toContain('暂不支持');expect(host.provider.snapshot().sessionId).toBe(id);
});
it.each([['codex',false],['claude',false],['codex',true],['claude',true]] as const)('reconnects missing empty %s sessions (shared=%s) without sending messages',async(harness,shared)=>{
  const root=mkdtempSync(resolve(tmpdir(),'pi-empty-reconnect-'));
  if(shared){host.provider.dispose();await host.provider.persistence.pending;host.home=root;host.config.sharedHistory=true;activate(context);await host.provider.historyReady;}
  const audit=resolve(root,'wire.jsonl');host.config[harness+'.env']={PI_TEST_AUDIT:audit};
  mockHarness(harness,`context-missing-${harness}`);
  try {
    await host.provider.perform({type:'switchHarness',harness});await host.provider.perform({type:'new'});
    await host.provider.perform({type:'config',id:'model',value:'other'});
    const first=host.provider.snapshot();
    for(let i=0;i<2;i++){
      await host.provider.perform({type:'releaseSession'});await host.provider.perform({type:'connect'});
      const state=host.provider.snapshot();
      expect(state).toMatchObject({status:'ready',entries:[],sessionNumber:first.sessionNumber});
      expect(state.sessionId).not.toBe(first.sessionId);expect(state.error).toContain('尚未落盘');
      expect(state.configs[0].currentValue).toBe('other');expect(state.commands[0].name).toBe('status');
      expect(host.provider.history).toHaveLength(1);
      if(shared)expect(await host.provider.sharedHistory.list()).toHaveLength(1);
    }
    expect(readFileSync(audit,'utf8')).not.toContain('session/prompt');
  }finally{host.provider.dispose();await host.provider.persistence.pending;host.home=undefined;rmSync(root,{recursive:true,force:true});}
});
it.each([['codex',true],['claude',true],['codex',false],['claude',false]] as const)('never recreates missing %s sessions unless proven empty (content=%s)',async(harness,withContent)=>{
  mockHarness(harness,`context-missing-${harness}`);await host.provider.perform({type:'switchHarness',harness});await host.provider.perform({type:'new'});
  if(withContent)await host.provider.perform({type:'send',text:'retained'});
  else host.provider.state.contextComplete=false;
  const before=host.provider.snapshot();
  await host.provider.perform({type:'releaseSession'});await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({status:'disconnected',readOnly:true,sessionId:before.sessionId,entries:before.entries});
  expect(host.provider.snapshot().error).toContain('不会自动新建');expect(host.provider.history).toHaveLength(1);
});
it.each(['codex','claude'] as const)('loads existing %s conversations after release without replacing the ID or entries',async harness=>{
  mockHarness(harness,'context');await host.provider.perform({type:'switchHarness',harness});await host.provider.perform({type:'new'});
  await host.provider.perform({type:'send',text:'keep this conversation'});const before=host.provider.snapshot();
  await host.provider.perform({type:'releaseSession'});await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:before.sessionId,entries:before.entries,sessionNumber:before.sessionNumber});
  expect(host.provider.history).toHaveLength(1);expect(host.provider.snapshot().error).toBeUndefined();
});
it('does not turn arbitrary internal errors into new empty sessions',async()=>{
  mockHarness('codex','context-load-fail');await host.provider.perform({type:'switchHarness',harness:'codex'});await host.provider.perform({type:'new'});
  const before=host.provider.snapshot();await host.provider.perform({type:'releaseSession'});await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({status:'disconnected',readOnly:true,sessionId:before.sessionId,error:'Internal error'});
});
it('retains external history read-only when session/load is unsupported, without fallback new',async()=>{
  mockHarness('claude');await host.provider.perform({type:'switchHarness',harness:'claude'});await host.provider.perform({type:'new'});await host.provider.perform({type:'send',text:'retained'});
  const id=host.provider.snapshot().sessionId;await host.provider.perform({type:'releaseSession'});
  mockHarness('claude','no-load');await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({harness:'claude',sessionId:id,status:'disconnected',readOnly:true});
  expect(host.provider.snapshot().error).toContain('session/load');
  expect(host.provider.snapshot().entries.some((e:any)=>e.text==='retained')).toBe(true);
});
it('restores the selected harness after restart and rejects stale cross-harness image messages',async()=>{
  mockHarness('codex');await host.provider.perform({type:'switchHarness',harness:'codex'});await host.provider.perform({type:'new'});
  const id=host.provider.snapshot().sessionId;host.provider.dispose();await host.provider.persistence.pending;activate(context);
  await host.provider.perform({type:'ready'});expect(host.provider.snapshot()).toMatchObject({harness:'codex',sessionId:id,status:'ready'});
  await host.provider.perform({type:'attachImages',harness:'pi',sessionId:id,images:[]});
  expect(host.provider.snapshot().error).toContain('Harness 已切换');
});
it('keeps the old harness usable if saving before a switch fails',async()=>{
  await host.provider.perform({type:'new'});
  vi.spyOn(host.provider,'save').mockRejectedValueOnce(new Error('storage unavailable'));
  await host.provider.perform({type:'switchHarness',harness:'codex'});
  expect(host.provider.snapshot()).toMatchObject({harness:'pi',status:'ready',error:'storage unavailable'});
});
it('returns to disconnected when a harness launch configuration is invalid',async()=>{
  await host.provider.perform({type:'switchHarness',harness:'claude'});
  host.config['claude.args']='not an array';
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot()).toMatchObject({harness:'claude',status:'disconnected'});
  expect(host.provider.snapshot().error).toContain('启动配置无效');
});
it('keeps Codex fast mode off and collaboration default on creation and load, rejecting stale switch controls',async()=>{
  mockHarness('codex','context-codex-options');await host.provider.perform({type:'switchHarness',harness:'codex'});await host.provider.perform({type:'new'});
  for(let i=0;i<2;i++){
    const configs=host.provider.snapshot().configs;
    expect(configs.find((c:any)=>c.id==='fast-mode').currentValue).toBe('off');
    expect(configs.find((c:any)=>c.id==='collaboration_mode').currentValue).toBe('default');
    await host.provider.perform({type:'config',id:'fast-mode',value:'on'});expect(host.provider.snapshot().error).toContain('默认值');
    await host.provider.perform({type:'releaseSession'});await host.provider.perform({type:'connect'});
    expect(host.provider.snapshot().status).toBe('ready');
  }
});
it('uses harness-specific login commands and never copies Pi profile environment overrides',async()=>{
  host.config.env={PI_ONLY:'secret'};mockHarness('codex');host.config['codex.env']={CODEX_ONLY:'value'};
  await host.provider.perform({type:'switchHarness',harness:'codex'});await host.provider.perform({type:'login'});
  expect(host.terminals.at(-1)).toMatchObject({shellPath:'codex',shellArgs:['login'],env:{CODEX_ONLY:'value'}});
  mockHarness('claude');await host.provider.perform({type:'switchHarness',harness:'claude'});await host.provider.perform({type:'login'});
  expect(host.terminals.at(-1)).toMatchObject({shellPath:process.execPath,shellArgs:[resolve('test/mock-agent.mjs'),'','--cli','/login'],env:{}});
});
it('restores ready even when saving session preferences fails after a turn', async () => {
  await host.provider.perform({type:'new'});
  const original = context.workspaceState.update;
  context.workspaceState.update = async (key: string, value: unknown) => {
    if (key === 'sessionPreferences') throw new Error('disk full');
    return original(key, value);
  };
  await host.provider.perform({type:'send',text:'hello'});
  expect(host.provider.snapshot()).toMatchObject({status:'ready',error:'disk full'});
  context.workspaceState.update = original;
  await host.provider.perform({type:'send',text:'another turn'});
  expect(host.provider.snapshot().status).toBe('ready');
});
it('locks preview before awaiting persistence', async () => {
  await host.provider.perform({type:'new'});
  let release!: () => void;
  vi.spyOn(host.provider, 'save').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const preview = host.provider.perform({type:'preview'});
  await host.provider.perform({type:'send',text:'must not send'});
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().entries).toEqual([]);
  release(); await preview;
  expect(host.provider.snapshot()).toMatchObject({status:'disconnected',preview:true});
});
it('removes usage titles and does not recreate them after forgetting an active conversation', async () => {
  await host.provider.perform({type:'new'});
  await host.provider.perform({type:'send',text:'private message'});
  await host.provider.recordUsage([]);
  expect(host.stored.get('usageTitles')).toEqual({'test-session':'private message'});
  await host.provider.perform({type:'deleteHistory',id:'test-session'});
  await host.provider.recordUsage([]);
  expect(host.stored.get('usageTitles')).toEqual({});
});
it.each([false, true])('disables local persistence during writes without deleting shared history (shared=%s)', async shared => {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-persistence-race-'));
  host.provider.dispose(); await host.provider.persistence.pending;
  host.home = root; host.config.sharedHistory = shared; activate(context);
  const provider = host.provider;
  try {
    await provider.perform({type:'new'});
    await provider.perform({type:'send',text:'private message'});
    await provider.recordUsage([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalWrite = provider.snapshots.write.bind(provider.snapshots);
    const write = vi.spyOn(provider.snapshots, 'write').mockImplementationOnce(async (snapshot: any) => {
      await gate;
      return originalWrite(snapshot);
    });
    const clear = vi.spyOn(provider.snapshots, 'clear');
    const saving = provider.save();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    host.config.persistHistory = false;
    host.configurationChanged!({affectsConfiguration:(key:string) => key === 'piAcp' || key === 'piAcp.persistHistory'});
    expect(clear).not.toHaveBeenCalled();
    host.config.persistHistory = true; // Even a quick toggle must invalidate the in-flight local save.
    release(); await saving; await provider.persistence.pending;
    expect(provider.history).toEqual([]);
    expect(host.stored.get('history')).toBeUndefined();
    expect(host.stored.get('usageTitles')).toEqual({});
    if (shared) {
      expect(clear).not.toHaveBeenCalled();
      const history = await provider.sharedHistory.list();
      expect(history).toHaveLength(1);
      expect((await provider.sharedHistory.read(history[0])).entries.some((e:any) => e.text === 'private message')).toBe(true);
      await provider.save(); // No tombstone was created; future saves still work.
      expect(await provider.sharedHistory.list()).toHaveLength(1);
    } else expect(clear).toHaveBeenCalledOnce();
  } finally {
    provider.dispose(); await provider.persistence.pending;
    host.home = undefined; rmSync(root, {recursive:true, force:true});
  }
});
it('bounds diff document storage and reuses repeated previews', async () => {
  await host.provider.perform({type:'new'});
  for (let i = 0; i < 25; i++) {
    const entry = {id:`tool-${i}`,role:'tool',tool:{toolCallId:`call-${i}`,title:'edit',content:[{type:'diff',path:'file.ts',oldText:'before',newText:'after'}]}};
    host.provider.state.entries.push(entry);
    await host.provider.openDiff(entry.id,0);
  }
  expect(host.provider.diffDocs.size).toBe(40);
  const keys = [...host.provider.diffDocs.keys()];
  await host.provider.openDiff('tool-24',0);
  expect([...host.provider.diffDocs.keys()]).toEqual(keys);
  expect(keys.some((key:any) => key.includes('tool-0-'))).toBe(false);
});
it('clears usage titles while preserving billed records and prices', async () => {
  await host.provider.perform({type:'new'});
  await host.provider.perform({type:'send',text:'private message'});
  const record = {id:'request',sessionId:'test-session',model:'model',timestamp:Date.now(),kind:'inference',input:1,output:1,cacheRead:0,cacheWrite:0};
  await host.provider.recordUsage([record]);
  const prices = structuredClone(host.provider.statistics.prices);
  await host.provider.perform({type:'clearHistory'});
  expect(host.stored.get('usageTitles')).toEqual({});
  expect(host.stored.get('usageRecords')).toEqual([record]);
  expect(host.provider.statistics.prices).toEqual(prices);
});
it('queues history deletion after in-flight snapshot writes', async () => {
  await host.provider.perform({type:'new'});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = vi.spyOn(host.provider.snapshots,'write').mockImplementationOnce(async (snapshot:any) => { await gate; return snapshot; });
  const saving = host.provider.save();
  await vi.waitFor(() => expect(write).toHaveBeenCalled());
  const clearing = host.provider.perform({type:'clearHistory'});
  release(); await Promise.all([saving, clearing]);
  expect(host.stored.get('history')).toBeUndefined();
  expect(host.provider.history).toEqual([]);
});
it('migrates and shares history across hosts, views occupied sessions, and hands off after release', async () => {
  const root = mkdtempSync(resolve(tmpdir(),'pi-controller-shared-'));
  host.provider.dispose(); await host.provider.persistence.pending;
  host.home=root; host.config.sharedHistory=true;
  const legacy = {id:'legacy',cwd:process.cwd(),title:'old',updated:1,contextComplete:true,entries:[{id:'old-user',role:'user',text:'old message'}]};
  host.stored.set('history',[legacy]);
  let first:any, second:any;
  const other = new Map<string,unknown>();
  try {
    activate(context); first=host.provider; await first.historyReady;
    expect(first.history.map((s:any)=>s.id)).toContain('legacy');
    expect(host.stored.get('sharedHistoryMigrated')).toBe(true);
    await first.perform({type:'new'}); await first.perform({type:'send',text:'shared message'});
    expect(first.snapshot().status).toBe('ready');
    activate({subscriptions:[],workspaceState:{get:(k:string,d:unknown)=>other.has(k)?other.get(k):d,update:async(k:string,v:unknown)=>other.set(k,structuredClone(v))}} as any);
    second=host.provider; await second.historyReady;
    expect(second.history.map((s:any)=>s.id)).toEqual(expect.arrayContaining(['legacy','test-session']));
    await second.perform({type:'resume',id:'test-session'});
    expect(second.snapshot()).toMatchObject({readOnly:true,status:'disconnected'});
    expect(second.snapshot().entries.some((e:any)=>e.text==='shared message')).toBe(true);
    await second.perform({type:'send',text:'must not send'});
    expect(second.snapshot().entries.some((e:any)=>e.text==='must not send')).toBe(false);
    await first.perform({type:'releaseSession'});
    await second.perform({type:'connect'});
    expect(second.snapshot()).toMatchObject({status:'ready'});
    expect(second.snapshot().readOnly).not.toBe(true);
    await second.perform({type:'send',text:'second machine'});
    await first.refreshSharedHistory();
    expect(first.snapshot().entries.some((e:any)=>e.text==='second machine')).toBe(true);
  } finally {
    first?.dispose();second?.dispose();await Promise.all([first?.persistence.pending,second?.persistence.pending]);
    host.home=undefined;rmSync(root,{recursive:true,force:true});
  }
});
it('does not create a session on ready, reconnect, or send; only explicit new does', async () => {
  const start = vi.spyOn(host.provider, 'start');
  await Promise.all([host.provider.perform({type:'ready'}), host.provider.perform({type:'ready'})]);
  await host.provider.perform({type:'connect'});
  await host.provider.perform({type:'send',text:'hello'});
  expect(start).not.toHaveBeenCalled();
  expect(host.provider.snapshot()).toMatchObject({status:'disconnected',entries:[]});
  await host.provider.perform({type:'new'});
  const id = host.provider.snapshot().sessionId;
  await host.provider.perform({type:'ready'});
  await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot().sessionId).toBe(id);
});
it('restores on opening and retries the same failed history without falling back to new', async () => {
  host.provider.history = [{id:'existing',cwd:process.cwd(),entries:[],contextComplete:true,title:'existing',updated:1}];
  host.config.args = [resolve('test/mock-agent.mjs'), 'v2'];
  const start = vi.spyOn(host.provider, 'start');
  await host.provider.perform({type:'ready'});
  const failed=host.provider.snapshot();
  expect(failed).toMatchObject({status:'disconnected',sessionId:'existing'});
  expect(failed.error).toBeTruthy();
  await host.provider.perform({type:'dismissError',error:failed.error});
  await host.provider.perform({type:'ready'});
  expect(start).toHaveBeenCalledTimes(1);
  host.config.args = [resolve('test/mock-agent.mjs')];
  await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:'existing'});
});
it('allows error dismissal during a turn without dismissing a newer error', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  // No active editor in this host: the attachment action creates an error while streaming.
  await host.provider.perform({ type: 'attach' });
  const error = host.provider.snapshot().error;
  expect(error).toBeTruthy();
  await host.provider.perform({ type: 'dismissError', error: 'an older error' });
  expect(host.provider.snapshot().error).toBe(error);
  await host.provider.perform({ type: 'dismissError', error });
  expect(host.provider.snapshot()).toMatchObject({ status: 'busy', error: undefined });
  await host.provider.perform({ type: 'attach' });
  expect(host.provider.snapshot().error).toBeTruthy();
  await host.provider.perform({ type: 'cancel' }); await turn;
});
it('keeps an explicitly opened offline preview disconnected', async () => {
  await host.provider.perform({ type: 'preview' });
  await host.provider.perform({ type: 'ready' });
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', preview: true });
  expect(host.provider.snapshot().connectionAttempted).toBeFalsy();
});
it('runs a complete turn through the controller, saves history, and loads it', async () => {
  await host.provider.perform({ type: 'new' }); expect(host.provider.snapshot().status).toBe('ready');
  await host.provider.perform({ type: 'send', text: 'hello' });
  const state = host.provider.snapshot(); expect(state.status).toBe('ready'); expect(state.entries).toContainEqual(expect.objectContaining({ role: 'assistant', text: '数学 $x^2$' }));
  expect((host.stored.get('history') as any[])[0].title).toBe('hello');
  await host.provider.perform({ type: 'resume', id: 'test-session' });
  expect(host.provider.snapshot().entries[0]).toMatchObject({ role: 'user', text: 'hello' });
});
it('serializes concurrent new requests without orphaning a process', async () => {
  await Promise.all([host.provider.perform({ type: 'new' }), host.provider.perform({ type: 'new' })]);
  expect(host.provider.snapshot().status).toBe('ready'); expect(host.provider.snapshot().error).toBeUndefined();
});
it('cancels pending permission requests when the user stops', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  await host.provider.perform({ type: 'cancel' }); await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0); expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().entries.at(-1).text).toContain('cancelled');
});
it('rejects forged permission option IDs and accepts the displayed option', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  const id = host.provider.snapshot().permissions[0].id;
  await host.provider.perform({ type: 'permission', id, optionId: 'invented' }); expect(host.provider.snapshot().permissions).toHaveLength(1);
  await host.provider.perform({ type: 'permission', id, optionId: 'yes' }); await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0); expect(host.provider.snapshot().status).toBe('ready');
});
it('blocks concurrent prompts and new sessions during an active turn', async () => {
  await host.provider.perform({ type: 'new' }); const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await host.provider.perform({ type: 'new' }); await host.provider.perform({ type: 'send', text: 'second' });
  expect(host.provider.snapshot().entries.filter((e: any) => e.role === 'user')).toHaveLength(1);
  await host.provider.perform({ type: 'cancel' }); await turn;
});
it('keeps a crash disconnected and surfaces an actionable error', async () => {
  await host.provider.perform({ type: 'new' }); await host.provider.perform({ type: 'send', text: 'crash' });
  expect(host.provider.snapshot().status).toBe('disconnected'); expect(host.provider.snapshot().error).toBeTruthy();
});
it('does not persist conversation content when history is disabled', async () => {
  host.config.persistHistory = false;
  await host.provider.perform({ type: 'new' }); await host.provider.perform({ type: 'send', text: 'hello' });
  expect(host.stored.get('history')).toBeUndefined();
});
it('deletes one historical record while preserving other records and the running turn', async () => {
  await host.provider.perform({ type: 'new' });
  host.provider.history.push({ id: 'older-session', title: 'older', cwd: process.cwd(), updated: 1, entries: [] });
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await host.provider.perform({ type: 'deleteHistory', id: 'older-session' });
  expect(host.provider.snapshot().status).toBe('busy');
  expect((host.stored.get('history') as any[]).map(item => item.id)).toEqual(['test-session']);
  expect((host.stored.get('history') as any[])[0].title).toBe('wait');
  await host.provider.perform({ type: 'cancel' }); await turn;
});
it('does not recreate a deleted current record when the turn completes or the provider saves again', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await host.provider.perform({ type: 'deleteHistory', id: 'test-session' });
  expect(host.provider.snapshot().status).toBe('busy');
  await host.provider.perform({ type: 'cancel' }); await turn;
  await host.provider.save();
  expect(host.stored.get('history')).toBeUndefined();
  expect(host.provider.snapshot().entries.some((e: any) => e.role === 'user')).toBe(true);
});
it('keeps cleared history empty after another automatic save', async () => {
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'clearHistory' });
  await host.provider.perform({ type: 'send', text: 'hello' });
  expect(host.stored.get('history')).toBeUndefined();
});

let auditDir: string | undefined;
afterEach(() => { if (auditDir) { rmSync(auditDir, { recursive: true, force: true }); auditDir = undefined; } });
async function contextAgent(mode='context') {
  auditDir = mkdtempSync(resolve(tmpdir(), 'pi-context-test-'));
  host.config.args = [resolve('test/mock-agent.mjs'), mode];
  host.config.env = { PI_TEST_AUDIT: resolve(auditDir, 'wire.jsonl') };
  await host.provider.perform({ type: 'new' });
}
it('assigns distinct native branch numbers and rejects message deletion without replacing the backend', async () => {
  await contextAgent('context-native'); await host.provider.perform({type:'send',text:'same title'});
  const original=host.provider.snapshot(); expect(original.sessionNumber).toBe(1);
  await host.provider.perform({type:'branchMessage',sessionId:original.sessionId,id:original.entries[0].id});
  const branch=host.provider.snapshot(); expect(branch.sessionNumber).toBe(2);
  expect(host.provider.history.map((s:any)=>s.title)).toEqual(['same title','same title']);
  await host.provider.perform({type:'deleteMessage',sessionId:branch.sessionId,id:branch.entries[0].id});
  expect(host.provider.snapshot().sessionId).toBe(branch.sessionId);
  expect(host.provider.snapshot().error).toContain('已移除');
  expect(host.provider.snapshot().sessionNumber).toBe(2);
});
function wire() { return readFileSync(resolve(auditDir!, 'wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
async function edit(type: 'branchMessage' | 'deleteMessage', id: string) {
  await host.provider.perform({ type, id, sessionId: host.provider.snapshot().sessionId });
}
it('branches at the native node, keeps historical settings, and never sends a textual seed or summary request', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'retained-first' });
  const old = host.provider.snapshot(), selected = old.entries.find((e: any) => e.role === 'assistant');
  await host.provider.perform({ type: 'send', text: 'excluded-later' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  await edit('branchMessage', selected.id);
  const branch = host.provider.snapshot();
  expect(branch.error).toBeUndefined(); expect(branch.sessionId).not.toBe(old.sessionId);
  expect(branch.entries).toEqual(old.entries.slice(0, 2)); expect(branch.contextPending).toBe(false); expect(branch.usage).toBeUndefined();
  expect(branch.configs.map((c: any) => c.currentValue)).toEqual(['default', 'low']);
  expect((host.stored.get('history') as any[]).find(s => s.id === old.sessionId).entries.some((e: any) => e.text === 'excluded-later')).toBe(true);
  expect(wire().filter(r => r.method === 'session/prompt')).toHaveLength(2);
  expect(wire().filter(r => r.method === 'session/load')).toHaveLength(1);
  expect(wire().filter(r => r.method === 'session/new')).toHaveLength(1);
  expect(wire().some(r => r.method === '_pi_workbench/summarize')).toBe(false);
  await host.provider.perform({ type: 'send', text: 'continue-here' });
  const prompt = wire().filter(r => r.method === 'session/prompt').at(-1).params;
  expect(prompt.sessionId).toBe(branch.sessionId);
  expect(prompt.prompt).toEqual([{type:'text',text:'continue-here'}]);
  expect(host.provider.snapshot().contextPending).toBe(false);
  await host.provider.perform({ type: 'send', text: 'one-more' });
  expect(wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt).toEqual([{ type: 'text', text: 'one-more' }]);
});
it('rejects obsolete user deletion requests and preserves attached history', async () => {
  await contextAgent();
  host.provider.state.attachments = [{ id: 'a', name: 'private.ts', uri: 'file:///private.ts', text: 'SECRET_ATTACHMENT_BODY' }];
  await host.provider.perform({ type: 'send', text: 'DELETE_THIS_USER' });
  const old = host.provider.snapshot(), removed = old.entries[0];
  expect(removed.contextBlocks).toBeDefined();
  await host.provider.perform({ type: 'send', text: 'keep-this-user' });
  await edit('deleteMessage', removed.id);
  expect(host.provider.snapshot().entries.some((e: any) => e.id === removed.id)).toBe(true);
  expect(host.provider.snapshot().error).toContain('已移除');
  expect((host.stored.get('history') as any[]).some(s => s.id === old.sessionId)).toBe(true);
  await host.provider.perform({ type: 'send', text: 'next-request' });
  const payload = JSON.stringify(wire().filter(r => r.method === 'session/prompt').at(-1));
  expect(payload).not.toContain('DELETE_THIS_USER'); expect(payload).not.toContain('SECRET_ATTACHMENT_BODY'); expect(payload).toContain('next-request');
  expect(host.provider.snapshot().entries[0].contextBlocks).toEqual(removed.contextBlocks);
});
it('rejects obsolete assistant deletion requests without changing the transcript', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'keep-user' });
  const old = host.provider.snapshot(), selected = old.entries.find((e: any) => e.role === 'assistant');
  await edit('deleteMessage', selected.id);
  expect(host.provider.snapshot().entries).toEqual(old.entries);
  await host.provider.perform({ type: 'send', text: 'continue' });
  const seed = wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text;
  expect(seed).toBe('continue');
});
it('preserves the visible transcript across native load and never re-injects it on a branch', async () => {
  await contextAgent('context-native'); await host.provider.perform({ type: 'send', text: 'uncompacted-history' });
  const original = host.provider.snapshot();host.provider.disconnect();host.provider.state.status='disconnected';
  await host.provider.perform({ type: 'resume', id: original.sessionId });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  await edit('branchMessage', original.entries[1].id);
  await host.provider.perform({ type: 'send', text: 'continue' });
  const seed = wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text;
  expect(seed).toBe('continue');
});
it('supports legacy unsent reconstructed snapshots across restart and blocks slash commands until synchronized', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retain-after-restart' });
  host.provider.state.contextPending=true;await host.provider.save(); // Legacy pre-native-fork snapshot.
  const branch = host.provider.snapshot();
  context.subscriptions.forEach((d: any) => d.dispose()); context.subscriptions = []; activate(context);
  await host.provider.perform({ type: 'resume', id: branch.sessionId });
  const resumed = host.provider.snapshot();
  expect(resumed.sessionId).not.toBe(branch.sessionId); expect(resumed.entries).toEqual(branch.entries);
  await host.provider.perform({ type: 'send', text: '/compact' });
  expect(host.provider.snapshot().error).toContain('先发送普通消息');
  expect(wire().filter(r => r.method === 'session/prompt')).toHaveLength(1);
  await host.provider.perform({ type: 'send', text: 'continue' });
  expect(wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text).toContain('retain-after-restart');
});
it('retains the original session and its usable agent when native forking fails', async () => {
  await contextAgent('context-native-fail'); await host.provider.perform({ type: 'send', text: 'original' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  const original = host.provider.snapshot();
  await edit('branchMessage', original.entries[0].id);
  expect(host.provider.snapshot()).toMatchObject({ sessionId: original.sessionId, entries: original.entries, status: 'ready' });
  expect(host.provider.snapshot().error).toBeTruthy();
  await host.provider.perform({ type: 'send', text: 'still-usable' });
  expect(host.provider.snapshot().error).toBeUndefined(); expect(host.provider.snapshot().status).toBe('ready');
});
it('recovers a legacy seeded-prompt failure in another fresh session', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retained' });
  host.provider.state.contextPending=true;await host.provider.save(); // Legacy unsynchronized context.
  const branch = host.provider.snapshot();
  await host.provider.perform({ type: 'send', text: 'crash' });
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', contextPending: true });
  await host.provider.perform({ type: 'connect' });
  const resumed = host.provider.snapshot();
  expect(resumed.sessionId).not.toBe(branch.sessionId); expect(resumed.contextPending).toBe(true);
  await host.provider.perform({ type: 'send', text: 'try-again' });
  const sent = wire().filter(r => r.method === 'session/prompt').at(-1).params;
  expect(sent.sessionId).toBe(resumed.sessionId); expect(sent.prompt[0].text).toContain('retained');
  expect(host.provider.snapshot().contextPending).toBe(false);
});
it('blocks stale branch actions, branching during generation, and unlocatable display messages', async () => {
  await contextAgent('context-native'); await host.provider.perform({ type: 'send', text: 'original' });
  const original = host.provider.snapshot();
  await host.provider.perform({ type: 'branchMessage', id: original.entries[0].id, sessionId: 'stale-session' });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await edit('branchMessage', original.entries[0].id);
  expect(host.provider.snapshot().entries[0]).toEqual(original.entries[0]);
  await host.provider.perform({ type: 'cancel' }); await turn;
  host.provider.state.entries.push({id:'unmapped',role:'user',text:'not in native history'});
  await edit('branchMessage', 'unmapped');
  expect(host.provider.snapshot().sessionId).toBe(original.sessionId); expect(host.provider.snapshot().error).toContain('无法唯一');
});
it('keeps cancelled legacy synchronization pending instead of assuming the peer retained it', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retained-before-cancel' });
  host.provider.state.contextPending=true;await host.provider.save(); // Legacy unsynchronized context.
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(wire().filter(r => r.method === 'session/prompt')).toHaveLength(2));
  await host.provider.perform({ type: 'cancel' }); await turn;
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', contextPending: true });
  await host.provider.perform({ type: 'connect' });
  await host.provider.perform({ type: 'send', text: 'continue' });
  expect(wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text).toContain('retained-before-cancel');
});
it('never falls back to large textual reconstruction when an adapter lacks native fork support', async () => {
  await contextAgent();
  host.provider.state.entries = [{ id: 'large', role: 'user', text: 'x'.repeat(2_010_000) }];
  const original=host.provider.snapshot();
  await edit('branchMessage', 'large');
  expect(host.provider.snapshot().error).toContain('不支持原生分支');
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  expect(host.provider.snapshot().sessionId).toBe(original.sessionId);
});
it('does not dispatch cancel before a prompt when the user stops during local persistence', async () => {
  await contextAgent();
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await host.provider.perform({ type: 'cancel' }); await turn;
  expect(host.provider.snapshot().status).toBe('ready');
  expect(wire().filter(r => r.method === 'session/prompt' || r.method === 'session/cancel')).toHaveLength(0);
  expect(host.provider.snapshot().entries.at(-1).text).toContain('尚未发送');
});

it('deduplicates billed requests, rejects deletion, and keeps native branch spending separate', async()=>{
  await contextAgent('context-native');await host.provider.perform({type:'send',text:'original'});
  const original=host.provider.snapshot().sessionId;
  const record={id:'native-request',sessionId:original,model:'p/m',timestamp:Date.now(),kind:'inference',input:100,output:20,cacheRead:80,cacheWrite:0};
  await host.provider.recordUsage([record]);await host.provider.recordUsage([record]);
  expect(host.stored.get('usageRecords')).toHaveLength(1);
  const assistant=host.provider.snapshot().entries.find((e:any)=>e.role==='assistant');
  await edit('deleteMessage',assistant.id);await host.provider.recordUsage([{...record,id:'after-delete',sessionId:host.provider.snapshot().sessionId}]);
  expect((host.stored.get('usageRecords') as any[]).map(r=>r.sessionId)).toEqual([original,original]);
  await edit('branchMessage',host.provider.snapshot().entries[0].id);
  await host.provider.recordUsage([{...record,id:'branch-request',sessionId:host.provider.snapshot().sessionId}]);
  expect((host.stored.get('usageRecords') as any[]).find(r=>r.id==='branch-request').sessionId).not.toBe(original);
});
it('keeps both shared histories and releases the source lease after native branching',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'pi-native-shared-'));
  host.provider.dispose();await host.provider.persistence.pending;host.home=root;host.config.sharedHistory=true;activate(context);await host.provider.historyReady;
  const {SharedHistoryStore}=await import('../src/shared-history');let reader:any;
  try{
    await contextAgent('context-native');await host.provider.perform({type:'send',text:'original'});
    const original=host.provider.snapshot();await host.provider.perform({type:'send',text:'later'});
    await edit('branchMessage',original.entries[1].id);
    const branch=host.provider.snapshot();expect(branch.error).toBeUndefined();expect(branch.sessionId).not.toBe(original.sessionId);
    reader=new SharedHistoryStore(host.provider.sharedHistory.root);const history=await reader.list();expect(history).toHaveLength(2);
    const saved=await reader.read(history.find((s:any)=>s.id===original.sessionId));expect(saved.entries.some((e:any)=>e.text==='later')).toBe(true);
    await reader.claim(original.sessionId);await expect(reader.claim(branch.sessionId)).rejects.toThrow('另一个窗口');
  }finally{await reader?.releaseAll();host.provider.dispose();await host.provider.persistence.pending;host.home=undefined;rmSync(root,{recursive:true,force:true});}
});
it('cancels native branch preparation without discarding the original connection',async()=>{
  await contextAgent('context-native');await host.provider.perform({type:'send',text:'original'});
  const before=host.provider.snapshot(),agent=host.provider.agent,request=agent.request.bind(agent);let rejectFork:((e:Error)=>void)|undefined;
  vi.spyOn(agent,'request').mockImplementation((method:any,params:any)=>{
    if(method==='_pi_workbench/fork')return new Promise((_,reject)=>{rejectFork=reject;});
    if(method==='_pi_workbench/cancel_fork'){rejectFork?.(new Error('cancelled native fork'));return Promise.resolve({});}
    return request(method,params);
  });
  const operation=edit('branchMessage',before.entries[1].id);await vi.waitFor(()=>expect(rejectFork).toBeDefined());
  expect(host.provider.snapshot().contextOperation).toEqual({kind:'fork'});
  await host.provider.perform({type:'cancelContext'});await operation;
  expect(host.provider.snapshot().contextOperation).toBeUndefined();
  expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:before.sessionId,entries:before.entries});expect(host.provider.agent).toBe(agent);
  expect(wire().some(r=>r.method==='_pi_workbench/summarize')).toBe(false);
});
it('keeps a source disconnect during native branching disconnected and reconnectable', async () => {
  await contextAgent('context-native'); await host.provider.perform({type:'send',text:'original'});
  const provider = host.provider, before = provider.snapshot(), agent = provider.agent;
  const request = agent.request.bind(agent);
  vi.spyOn(agent, 'request').mockImplementation((method:any, params:any) => {
    if (method !== '_pi_workbench/fork') return request(method, params);
    agent.dispose(); agent.options.closed('source disconnected during fork');
    return Promise.reject(new Error('ACP connection closed'));
  });
  await edit('branchMessage', before.entries[1].id);
  expect(provider.snapshot()).toMatchObject({status:'disconnected',sessionId:before.sessionId,entries:before.entries});
  expect(provider.snapshot().contextOperation).toBeUndefined();
  expect(provider.agent).toBeUndefined();
  await provider.perform({type:'connect'});
  expect(provider.snapshot()).toMatchObject({status:'ready',sessionId:before.sessionId});
});
it('refuses a changed target adapter rather than replaying history into it',async()=>{
  await contextAgent('context-native');await host.provider.perform({type:'send',text:'original'});const before=host.provider.snapshot();
  host.config.args=[resolve('test/mock-agent.mjs'),'context'];await edit('branchMessage',before.entries[0].id);
  expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:before.sessionId,entries:before.entries});expect(host.provider.snapshot().error).toContain('目标适配器');
});
it('persists custom prices, rejects invalid numbers and restores defaults',async()=>{
 await host.provider.perform({type:'setPrice',model:'p/m',price:{input:2,output:3,cacheRead:.2,cacheWrite:2.5}});
 expect(host.stored.get('prices')).toMatchObject({'p/m':{input:2}});
 await host.provider.perform({type:'setPrice',model:'p/m',price:{input:-1,output:3,cacheRead:.2,cacheWrite:2.5}});
 expect(host.stored.get('prices')).toMatchObject({'p/m':{input:2}});
 await host.provider.perform({type:'setPrice',model:'p/m'});expect(host.stored.get('prices')).toEqual({});
});
it('copies original full Markdown even when a compacted checkpoint exists',async()=>{
 const vscode=await import('vscode');await contextAgent();await host.provider.perform({type:'send',text:'Original equation $x^2$'});
 host.provider.checkpoints=[{count:2,hash:'irrelevant',text:'short summary',source:'pi',id:'cp'}];
 await host.provider.perform({type:'copyConversation'});
 expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Original equation $x^2$'));
 expect(vscode.env.clipboard.writeText).not.toHaveBeenLastCalledWith(expect.stringContaining('short summary'));
});

it('switches cached conversations without initializing/loading again and preserves model settings',async()=>{
 await contextAgent();await host.provider.perform({type:'send',text:'first'});const first=host.provider.snapshot(),agent=host.provider.agent;
 await host.provider.perform({type:'config',id:'model',value:'other'});
 await host.provider.perform({type:'new'});const second=host.provider.snapshot().sessionId;await host.provider.perform({type:'send',text:'second'});
 const before=wire().length;await host.provider.perform({type:'resume',id:first.sessionId});
 expect(host.provider.agent).toBe(agent);expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:first.sessionId,entries:first.entries});expect(host.provider.snapshot().configs[0].currentValue).toBe('other');
 expect(wire().slice(before).filter(r=>['initialize','session/load','session/new'].includes(r.method))).toHaveLength(0);
 await host.provider.perform({type:'resume',id:second});expect(host.provider.snapshot().entries[0].text).toBe('second');
});
it('evicts idle LRU connections and falls back to native loading for an evicted conversation',async()=>{
 await contextAgent();const first=host.provider.snapshot().sessionId,agent=host.provider.agent;
 for(let i=0;i<3;i++)await host.provider.perform({type:'new'});
 expect(host.provider.sessions.size).toBe(2);expect(agent.isClosed).toBe(true);
 await host.provider.perform({type:'resume',id:first});expect(wire().filter(r=>r.method==='session/load').at(-1).params.sessionId).toBe(first);
});
it('reconnects dead cached agents and clears live caches on history deletion and disposal',async()=>{
 await contextAgent();const first=host.provider.snapshot().sessionId,agent=host.provider.agent;await host.provider.perform({type:'new'});agent.dispose();
 await host.provider.perform({type:'resume',id:first});expect(host.provider.agent).not.toBe(agent);expect(host.provider.snapshot().status).toBe('ready');
 await host.provider.perform({type:'new'});const cached=host.provider.sessions.get(first).agent;
 await host.provider.perform({type:'deleteHistory',id:first});expect(cached.isClosed).toBe(true);expect(host.provider.sessions.get(first)).toBeUndefined();
 const current=host.provider.agent;host.provider.dispose();expect(current.isClosed).toBe(true);expect(host.provider.sessions.size).toBe(0);
});
const pastedPng={name:'clipboard.png',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='};
it('sends image-only messages as ACP image blocks and preserves the original image in local history',async()=>{
 await contextAgent('context-images');const sessionId=host.provider.snapshot().sessionId;
 await host.provider.perform({type:'attachImages',sessionId,images:[pastedPng]});expect(host.provider.snapshot().attachments[0].kind).toBe('image');
 await host.provider.perform({type:'send',text:''});const prompt=wire().filter(r=>r.method==='session/prompt').at(-1).params.prompt;
 expect(prompt).toEqual([{type:'image',mimeType:pastedPng.mimeType,data:pastedPng.data}]);expect(host.provider.snapshot().attachments).toEqual([]);
 expect(host.provider.snapshot().entries[0].contextBlocks).toEqual(prompt);expect((host.stored.get('history') as any[])[0].entries[0].contextBlocks).toEqual(prompt);
});
it('retains image drafts when the agent lacks image support and permits removal',async()=>{
 await contextAgent();const sessionId=host.provider.snapshot().sessionId;await host.provider.perform({type:'attachImages',sessionId,images:[pastedPng]});
 await host.provider.perform({type:'send',text:'image'});expect(host.provider.snapshot().error).toContain('未声明图片支持');expect(wire().some(r=>r.method==='session/prompt')).toBe(false);
 const id=host.provider.snapshot().attachments[0].id;await host.provider.perform({type:'removeAttachment',id});expect(host.provider.snapshot().attachments).toEqual([]);
});
it('rejects stale image pastes and validates an entire batch before adding any attachment',async()=>{
 await contextAgent();const sessionId=host.provider.snapshot().sessionId;
 await host.provider.perform({type:'attachImages',sessionId:'stale',images:[pastedPng]});expect(host.provider.snapshot().attachments).toEqual([]);
 await host.provider.perform({type:'attachImages',sessionId,images:[pastedPng,{...pastedPng,mimeType:'image/svg+xml'}]});expect(host.provider.snapshot().attachments).toEqual([]);
});

it('inherits model then thinking after model-dependent options change, without setting duplicate modes', async () => {
  await contextAgent('context-dependent');
  await host.provider.perform({type:'config',id:'model',value:'other'});
  await host.provider.perform({type:'config',id:'thinking',value:'high'});
  const old=host.provider.snapshot().sessionId, before=wire().length;
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().sessionId).not.toBe(old);
  expect(host.provider.snapshot().configs.map((c:any)=>c.currentValue)).toEqual(['other','high']);
  expect(wire().slice(before).filter(r=>r.method.startsWith('session/set_')).map(r=>r.params))
    .toEqual([{sessionId:host.provider.snapshot().sessionId,configId:'model',value:'other'}, {sessionId:host.provider.snapshot().sessionId,configId:'thinking',value:'high'}]);
});
it('persists successful selections immediately and inherits them after restart even without history', async () => {
  host.config.persistHistory=false;
  await contextAgent();
  await host.provider.perform({type:'config',id:'model',value:'other'});
  await host.provider.perform({type:'config',id:'thinking',value:'high'});
  expect(host.stored.get('sessionPreferences')).toEqual([{kind:'model',value:'other'},{kind:'thinking',value:'high'}]);
  host.provider.dispose();await host.provider.persistence.pending;activate(context);
  const before=wire().length;
  await host.provider.perform({type:'ready'});
  expect(wire().length).toBe(before);
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().configs.map((c:any)=>c.currentValue)).toEqual(['other','high']);
});
it('inherits legacy reasoning modes when configOptions does not provide thinking', async () => {
  await contextAgent('context-legacy');
  await host.provider.perform({type:'mode',value:'high'});
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().modes.currentModeId).toBe('high');
  expect(wire().filter(r=>r.method==='session/set_mode')).toHaveLength(2);
});
it('resumes the last active warm conversation after restart, and reconnects it without session/new', async () => {
  await contextAgent();const first=host.provider.snapshot().sessionId;
  await host.provider.perform({type:'send',text:'first'});
  await host.provider.perform({type:'new'});
  await host.provider.perform({type:'resume',id:first});
  expect(host.stored.get('activeSession')).toBe(first);
  host.provider.dispose();await host.provider.persistence.pending;activate(context);
  const before=wire().length;
  await host.provider.perform({type:'ready'});
  expect(host.provider.snapshot()).toMatchObject({status:'ready',sessionId:first});
  host.provider.disconnect();host.provider.state.status='disconnected';
  await host.provider.perform({type:'connect'});
  expect(wire().slice(before).filter(r=>r.method==='session/new')).toHaveLength(0);
  expect(wire().slice(before).filter(r=>r.method==='session/load').map(r=>r.params.sessionId)).toEqual([first,first]);
});
it('uses the selected historical conversation settings for the next new conversation', async () => {
  await contextAgent();const first=host.provider.snapshot().sessionId;
  await host.provider.perform({type:'new'});
  await host.provider.perform({type:'config',id:'model',value:'other'});
  await host.provider.perform({type:'resume',id:first});
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().configs[0].currentValue).toBe('default');
});
it('does not replace an unavailable native session with a new one', async () => {
  await contextAgent();const first=host.provider.snapshot().sessionId;
  host.provider.disconnect();host.provider.state.status='disconnected';host.config.args=[resolve('test/mock-agent.mjs'),'no-load'];
  const before=wire().length;
  await host.provider.perform({type:'connect'});
  expect(host.provider.snapshot()).toMatchObject({status:'disconnected',sessionId:first});
  expect(host.provider.snapshot().error).toContain('session/load');
  expect(wire().slice(before).some(r=>r.method==='session/new')).toBe(false);
});
it('does not auto-open a different history after deleting the last active record', async () => {
  await contextAgent();await host.provider.perform({type:'new'});
  await host.provider.perform({type:'deleteHistory',id:host.provider.snapshot().sessionId});
  host.provider.dispose();await host.provider.persistence.pending;activate(context);
  const before=wire().length;
  await host.provider.perform({type:'ready'});
  expect(host.provider.snapshot().sessionId).toBeUndefined();expect(wire().length).toBe(before);
});
it('warns about unavailable inherited values without retrying or silently creating extra sessions', async () => {
  await contextAgent();host.provider.dispose();await host.provider.persistence.pending;
  host.stored.set('sessionPreferences',[{kind:'model',value:'removed-model'},{kind:'thinking',value:'removed-level'}]);
  activate(context);const before=wire().length;
  await host.provider.perform({type:'new'});
  expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().error).toContain('上次的设置当前不可用');
  expect(wire().slice(before).filter(r=>r.method==='session/new')).toHaveLength(1);
});
