import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const host = vi.hoisted(() => ({ provider: undefined as any, config: {} as Record<string, unknown>, stored: new Map<string, unknown>(), commands: new Map<string, Function>(), updates: [] as unknown[] }));
vi.mock('vscode', () => ({
  env:{clipboard:{writeText:vi.fn(async()=>{})}},
  workspace: {
    isTrusted: true,
    get workspaceFolders() { return [{ uri: { scheme: 'file', fsPath: process.cwd() } }]; },
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => host.config[key] ?? fallback }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
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
  host.config = { command: process.execPath, args: [resolve('test/mock-agent.mjs')] }; host.stored.clear();
  context = { subscriptions: [], workspaceState: { get: (key: string, fallback: unknown) => host.stored.get(key) ?? fallback, update: async (key: string, value: unknown) => host.stored.set(key, structuredClone(value)) } };
  activate(context);
});
afterEach(() => { context.subscriptions.forEach((d: { dispose(): void }) => d.dispose()); });
it('connects when the chat becomes ready and preserves the session on repeated ready events', async () => {
  const start = vi.spyOn(host.provider, 'start');
  expect(host.provider.snapshot().connectionAttempted).toBeFalsy();
  await Promise.all([host.provider.perform({ type: 'ready' }), host.provider.perform({ type: 'ready' })]);
  expect(host.provider.snapshot()).toMatchObject({ status: 'ready', connectionAttempted: true });
  await host.provider.perform({ type: 'send', text: 'hello' });
  const entries = host.provider.snapshot().entries;
  await host.provider.perform({ type: 'ready' });
  expect(start).toHaveBeenCalledTimes(1);
  expect(host.provider.snapshot().entries).toEqual(entries);
});
it('does not loop after an automatic connection failure and permits a manual retry after dismissing it', async () => {
  host.config.args = [resolve('test/mock-agent.mjs'), 'v2'];
  const start = vi.spyOn(host.provider, 'start');
  await host.provider.perform({ type: 'ready' });
  const failed = host.provider.snapshot();
  expect(failed).toMatchObject({ status: 'disconnected', connectionAttempted: true });
  expect(failed.error).toBeTruthy();
  await host.provider.perform({ type: 'dismissError', error: failed.error });
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().connectionAttempted).toBe(true);
  await host.provider.perform({ type: 'ready' });
  expect(start).toHaveBeenCalledTimes(1);
  host.config.args = [resolve('test/mock-agent.mjs')];
  await host.provider.perform({ type: 'connect' });
  expect(host.provider.snapshot().status).toBe('ready');
});
it('allows error dismissal during a turn without dismissing a newer error', async () => {
  await host.provider.perform({ type: 'connect' });
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
  await host.provider.perform({ type: 'connect' }); expect(host.provider.snapshot().status).toBe('ready');
  await host.provider.perform({ type: 'send', text: 'hello' });
  const state = host.provider.snapshot(); expect(state.status).toBe('ready'); expect(state.entries).toContainEqual(expect.objectContaining({ role: 'assistant', text: '数学 $x^2$' }));
  expect((host.stored.get('history') as any[])[0].title).toBe('hello');
  await host.provider.perform({ type: 'resume', id: 'test-session' });
  expect(host.provider.snapshot().entries[0]).toMatchObject({ role: 'user', text: 'hello' });
});
it('serializes concurrent connect requests without orphaning a process', async () => {
  await Promise.all([host.provider.perform({ type: 'connect' }), host.provider.perform({ type: 'new' })]);
  expect(host.provider.snapshot().status).toBe('ready'); expect(host.provider.snapshot().error).toBeUndefined();
});
it('cancels pending permission requests when the user stops', async () => {
  await host.provider.perform({ type: 'connect' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  await host.provider.perform({ type: 'cancel' }); await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0); expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().entries.at(-1).text).toContain('cancelled');
});
it('rejects forged permission option IDs and accepts the displayed option', async () => {
  await host.provider.perform({ type: 'connect' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  const id = host.provider.snapshot().permissions[0].id;
  await host.provider.perform({ type: 'permission', id, optionId: 'invented' }); expect(host.provider.snapshot().permissions).toHaveLength(1);
  await host.provider.perform({ type: 'permission', id, optionId: 'yes' }); await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0); expect(host.provider.snapshot().status).toBe('ready');
});
it('blocks concurrent prompts and new sessions during an active turn', async () => {
  await host.provider.perform({ type: 'connect' }); const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await host.provider.perform({ type: 'new' }); await host.provider.perform({ type: 'send', text: 'second' });
  expect(host.provider.snapshot().entries.filter((e: any) => e.role === 'user')).toHaveLength(1);
  await host.provider.perform({ type: 'cancel' }); await turn;
});
it('keeps a crash disconnected and surfaces an actionable error', async () => {
  await host.provider.perform({ type: 'connect' }); await host.provider.perform({ type: 'send', text: 'crash' });
  expect(host.provider.snapshot().status).toBe('disconnected'); expect(host.provider.snapshot().error).toBeTruthy();
});
it('does not persist conversation content when history is disabled', async () => {
  host.config.persistHistory = false;
  await host.provider.perform({ type: 'connect' }); await host.provider.perform({ type: 'send', text: 'hello' });
  expect(host.stored.get('history')).toBeUndefined();
});
it('deletes one historical record while preserving other records and the running turn', async () => {
  await host.provider.perform({ type: 'connect' });
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
  await host.provider.perform({ type: 'connect' });
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
  await host.provider.perform({ type: 'connect' });
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
  await host.provider.perform({ type: 'connect' });
}
function wire() { return readFileSync(resolve(auditDir!, 'wire.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
async function edit(type: 'branchMessage' | 'deleteMessage', id: string) {
  await host.provider.perform({ type, id, sessionId: host.provider.snapshot().sessionId });
}
it('branches inclusively into a fresh ACP session, keeps the original, and seeds exactly once on the next prompt', async () => {
  await contextAgent();
  await host.provider.perform({ type: 'send', text: 'retained-first' });
  const old = host.provider.snapshot(), selected = old.entries.find((e: any) => e.role === 'assistant');
  await host.provider.perform({ type: 'send', text: 'excluded-later' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  await edit('branchMessage', selected.id);
  const branch = host.provider.snapshot();
  expect(branch.error).toBeUndefined(); expect(branch.sessionId).not.toBe(old.sessionId);
  expect(branch.entries).toEqual(old.entries.slice(0, 2)); expect(branch.contextPending).toBe(true); expect(branch.usage).toBeUndefined();
  expect(branch.configs.map((c: any) => c.currentValue)).toEqual(['other', 'high']);
  expect((host.stored.get('history') as any[]).find(s => s.id === old.sessionId).entries.some((e: any) => e.text === 'excluded-later')).toBe(true);
  expect(wire().filter(r => r.method === 'session/prompt')).toHaveLength(2);
  expect(wire().some(r => r.method === 'session/load')).toBe(false);
  await host.provider.perform({ type: 'send', text: 'continue-here' });
  const prompt = wire().filter(r => r.method === 'session/prompt').at(-1).params;
  expect(prompt.sessionId).toBe(branch.sessionId);
  expect(prompt.prompt[0].text).toContain('retained-first'); expect(prompt.prompt[0].text).toContain('数学');
  expect(prompt.prompt[0].text).not.toContain('excluded-later'); expect(prompt.prompt[1].text).toBe('continue-here');
  expect(host.provider.snapshot().contextPending).toBe(false);
  await host.provider.perform({ type: 'send', text: 'one-more' });
  expect(wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt).toEqual([{ type: 'text', text: 'one-more' }]);
});
it('deletes an individual user message including its attached content from the next actual ACP prompt', async () => {
  await contextAgent();
  host.provider.state.attachments = [{ id: 'a', name: 'private.ts', uri: 'file:///private.ts', text: 'SECRET_ATTACHMENT_BODY' }];
  await host.provider.perform({ type: 'send', text: 'DELETE_THIS_USER' });
  const old = host.provider.snapshot(), removed = old.entries[0];
  expect(removed.contextBlocks).toBeDefined();
  await host.provider.perform({ type: 'send', text: 'keep-this-user' });
  await edit('deleteMessage', removed.id);
  expect(host.provider.snapshot().entries.some((e: any) => e.id === removed.id)).toBe(false);
  expect((host.stored.get('history') as any[]).some(s => s.id === old.sessionId)).toBe(false);
  await host.provider.perform({ type: 'send', text: 'next-request' });
  const payload = JSON.stringify(wire().filter(r => r.method === 'session/prompt').at(-1));
  expect(payload).not.toContain('DELETE_THIS_USER'); expect(payload).not.toContain('SECRET_ATTACHMENT_BODY'); expect(payload).toContain('keep-this-user');
  expect(payload).toContain('tool');
});
it('removes an assistant message without removing adjacent user or tool messages', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'keep-user' });
  const old = host.provider.snapshot(), selected = old.entries.find((e: any) => e.role === 'assistant');
  await edit('deleteMessage', selected.id);
  expect(host.provider.snapshot().entries.map((e: any) => e.role)).toEqual(['user', 'tool']);
  await host.provider.perform({ type: 'send', text: 'continue' });
  const seed = wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text;
  expect(seed).toContain('keep-user'); expect(seed).not.toContain('数学');
});
it('preserves the complete visible transcript when resuming a remotely compacted session', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'uncompacted-history' });
  const original = host.provider.snapshot();host.provider.disconnect();host.provider.state.status='disconnected';
  await host.provider.perform({ type: 'resume', id: original.sessionId });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  await edit('branchMessage', original.entries[1].id);
  await host.provider.perform({ type: 'send', text: 'continue' });
  const seed = wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text;
  expect(seed).toContain('uncompacted-history'); expect(seed).not.toContain('previous');
});
it('persists unsent reconstructed context across extension restart and blocks slash commands until it is sent', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retain-after-restart' });
  await edit('branchMessage', host.provider.snapshot().entries[1].id);
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
it('retains the original session and its usable agent when preparing a replacement fails', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'original' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  const original = host.provider.snapshot();
  host.config.args = [resolve('test/mock-agent.mjs'), 'context-config-fail'];
  await edit('deleteMessage', original.entries[0].id);
  expect(host.provider.snapshot()).toMatchObject({ sessionId: original.sessionId, entries: original.entries, status: 'ready' });
  expect(host.provider.snapshot().error).toBeTruthy();
  await host.provider.perform({ type: 'send', text: 'still-usable' });
  expect(host.provider.snapshot().error).toBeUndefined(); expect(host.provider.snapshot().status).toBe('ready');
});
it('reconstructs in another fresh session after an ambiguous seeded-prompt failure', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retained' });
  await edit('branchMessage', host.provider.snapshot().entries[1].id);
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
it('blocks stale session actions, edits during generation and incomplete saved histories', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'original' });
  const original = host.provider.snapshot();
  await host.provider.perform({ type: 'deleteMessage', id: original.entries[0].id, sessionId: 'stale-session' });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await edit('deleteMessage', original.entries[0].id);
  expect(host.provider.snapshot().entries[0]).toEqual(original.entries[0]);
  await host.provider.perform({ type: 'cancel' }); await turn;
  host.provider.state.contextComplete = false;
  await edit('branchMessage', original.entries[0].id);
  expect(host.provider.snapshot().sessionId).toBe(original.sessionId); expect(host.provider.snapshot().error).toContain('不完整');
});
it('keeps a cancelled first synchronization pending instead of assuming the peer retained it', async () => {
  await contextAgent(); await host.provider.perform({ type: 'send', text: 'retained-before-cancel' });
  await edit('branchMessage', host.provider.snapshot().entries[1].id);
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(wire().filter(r => r.method === 'session/prompt')).toHaveLength(2));
  await host.provider.perform({ type: 'cancel' }); await turn;
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', contextPending: true });
  await host.provider.perform({ type: 'connect' });
  await host.provider.perform({ type: 'send', text: 'continue' });
  expect(wire().filter(r => r.method === 'session/prompt').at(-1).params.prompt[0].text).toContain('retained-before-cancel');
});
it('rejects oversized reconstruction when the external adapter lacks bounded summary support', async () => {
  await contextAgent();
  host.provider.state.entries = [{ id: 'large', role: 'user', text: 'x'.repeat(2_010_000) }];
  const original=host.provider.snapshot();
  await edit('branchMessage', 'large');
  expect(host.provider.snapshot().error).toContain('安全输入预算');
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

it('deduplicates billed requests, preserves logical conversations after deletion, and keeps branch spending separate', async()=>{
  await contextAgent();await host.provider.perform({type:'send',text:'original'});
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
