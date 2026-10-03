import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
const host = vi.hoisted(() => ({ provider: undefined as any, config: {} as Record<string, unknown>, stored: new Map<string, unknown>(), commands: new Map<string, Function>(), updates: [] as unknown[] }));
vi.mock('vscode', () => ({
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
  expect(host.provider.snapshot().entries[0]).toMatchObject({ role: 'user', text: 'previous' });
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
