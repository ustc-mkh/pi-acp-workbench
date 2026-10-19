import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as vscode from 'vscode';
import type { WorkbenchProvider } from '../src/workbench-extension';
import { workbenchPeer, emptyView } from './helpers/workbench-peer';
const host = vi.hoisted(() => ({
  socket: '',
  workspace: '',
  trusted: true,
  provider: undefined as WorkbenchProvider | undefined,
  commands: new Map<string, () => unknown>(),
}));
vi.mock('vscode', () => ({
  Uri: {
    joinPath: (root: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [root.fsPath, ...parts].join('/'),
      toString() {
        return this.fsPath;
      },
    }),
  },
  workspace: {
    get isTrusted() {
      return host.trusted;
    },
    get workspaceFolders() {
      return [{ uri: { fsPath: host.workspace } }];
    },
    getConfiguration: () => ({
      get: (key: string) => (key === 'workbenchSocket' ? host.socket : undefined),
    }),
  },
  window: {
    registerWebviewViewProvider: (_: string, provider: WorkbenchProvider) => {
      host.provider = provider;
      return { dispose() {} };
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: {
    registerCommand: (name: string, run: () => unknown) => {
      host.commands.set(name, run);
      return { dispose() {} };
    },
    executeCommand: vi.fn(async () => {}),
  },
}));
import { activate } from '../src/workbench-extension';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.provider = undefined;
  host.commands.clear();
  host.trusted = true;
});
it('production entry configures only v2 socket, restricts CSP resources and rejects canonical workspace escapes/trust revocation', async () => {
  const peer = await workbenchPeer();
  cleanups.push(() => peer.close());
  const root = await mkdtemp(join(tmpdir(), 'wb-extension-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'),
    outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, 'escape'));
  host.socket = peer.path;
  host.workspace = workspace;
  const subscriptions: vscode.Disposable[] = [];
  activate({ subscriptions, extensionUri: { fsPath: root } } as unknown as vscode.ExtensionContext);
  cleanups.push(async () => {
    subscriptions.reverse().forEach((item) => item.dispose());
  });
  const provider = host.provider!;
  const posted: unknown[] = [];
  let receive: ((value: unknown) => void) | undefined;
  const webview = {
    html: '',
    options: {},
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
    onDidReceiveMessage: (callback: (value: unknown) => void) => {
      receive = callback;
      return { dispose() {} };
    },
    postMessage: async (value: unknown) => {
      posted.push(value);
      return true;
    },
  };
  provider.resolveWebviewView({
    webview,
    onDidDispose: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView);
  expect(webview.html).toContain("connect-src 'none'");
  expect(webview.html).toContain('img-src blob:');
  expect(webview.html).toMatch(/nonce-[A-Za-z0-9_-]+/);
  expect(receive).toBeTypeOf('function');
  await provider.controller.receive({
    type: 'create',
    command: { method: 'create', harness: 'Pi', cwd: join(workspace, 'escape') },
  });
  expect(provider.controller.snapshot.error).toContain('Open this session workspace');
  expect(peer.requests).toHaveLength(0);
  host.trusted = false;
  await host.commands.get('piAcp.newSession')!();
  expect(provider.controller.snapshot.error).toContain('trust');
  expect(peer.requests).toHaveLength(0);
  host.trusted = true;
  const creating = host.commands.get('piAcp.newSession')!();
  await expect.poll(() => peer.requests.length).toBe(1);
  expect(peer.requests[0].command).toEqual({ method: 'create', harness: 'Pi', cwd: workspace });
  const view = { ...emptyView(), cwd: workspace };
  peer.reply(peer.requests[0], {
    Created: {
      summary: {
        id: view.id,
        harness: view.harness,
        cwd: view.cwd,
        status: view.status,
        revision: view.revision,
        created_seq: 1,
      },
    },
  });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.query(peer.requests[1], 'attached', {
    view,
    recent_page: { entries: [], next_cursor: null },
  });
  await creating;
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  expect(provider.controller.snapshot.view?.status).toBe('ready');
});
