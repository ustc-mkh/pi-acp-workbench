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
  contentProvider: undefined as vscode.TextDocumentContentProvider | undefined,
  documents: [] as { isDirty: boolean; uri: { scheme: string; fsPath: string } }[],
}));
vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { scheme: string; path: string }) => ({
      ...parts,
      toString() {
        return `${this.scheme}:${this.path}`;
      },
    }),
    joinPath: (root: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [root.fsPath, ...parts].join('/'),
      toString() {
        return this.fsPath;
      },
    }),
  },
  workspace: {
    get textDocuments() {
      return host.documents;
    },
    registerTextDocumentContentProvider: (
      _scheme: string,
      provider: vscode.TextDocumentContentProvider,
    ) => {
      host.contentProvider = provider;
      return { dispose() {} };
    },
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
  host.documents = [];
  vi.clearAllMocks();
});
it('refuses explicit activation in an untrusted workspace before registering resources', () => {
  host.trusted = false;
  const subscriptions: vscode.Disposable[] = [];
  expect(() => activate({ subscriptions } as unknown as vscode.ExtensionContext)).toThrow('信任');
  expect(subscriptions).toEqual([]);
  expect(host.provider).toBeUndefined();
});

it('production entry configures only v3 socket, restricts CSP resources and rejects canonical workspace escapes/trust revocation', async () => {
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
  const view = { ...emptyView(), cwd: workspace, last_entry_seq: 1 };
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
  const attachedPage = {
    view,
    recent_page: {
      entries: [
        {
          seq: 1,
          id: 'entry',
          turn: 'turn',
          role: 'User',
          text: { Inline: { text: 'edit' } },
          message: null,
          image: null,
        },
      ],
      next_cursor: null,
    },
  };
  peer.query(peer.requests[1], 'attached', attachedPage);
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command.method).toBe('discover');
  peer.reply(peer.requests[2], { Loaded: { view } });
  await expect.poll(() => peer.requests.length).toBe(4);
  peer.query(peer.requests[3], 'attached', attachedPage);
  await creating;
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  expect(provider.controller.snapshot.view?.status).toBe('ready');
  const opening = provider.controller.receive({
    type: 'open_turn_diff',
    session: 'session',
    turn: 'turn',
  });
  await expect.poll(() => peer.requests.length).toBe(5);
  peer.query(peer.requests[4], 'turn_diff', {
    status: 'complete',
    files: ['a.ts', 'b.ts'].map((path) => ({
      path,
      status: 'modified',
      before_hash: 'a'.repeat(64),
      after_hash: 'b'.repeat(64),
      before: null,
      after: null,
      old_mode: 33188,
      new_mode: 33188,
      added: 1,
      removed: 1,
      patch: null,
      omitted: 'Diff content can be loaded in bounded slices.',
    })),
    warnings: [],
    added: 2,
    removed: 2,
    next_offset: null,
  });
  for (let i = 0; i < 4; i++) {
    await expect.poll(() => peer.requests.length).toBe(6 + i);
    peer.query(peer.requests[5 + i], 'turn_diff_content', {
      bytes: i % 2 ? 'after' : 'before',
      total_bytes: i % 2 ? 5 : 6,
      next_offset: null,
    });
  }
  await opening;
  const api = await import('vscode');
  expect(api.commands.executeCommand).toHaveBeenCalledWith(
    '_workbench.openMultiDiffEditor',
    expect.objectContaining({ resources: expect.any(Array) }),
  );
  const calls = vi.mocked(api.commands.executeCommand).mock.calls;
  const options = calls.at(-1)![1] as {
    resources: { originalUri: vscode.Uri; modifiedUri: vscode.Uri }[];
  };
  expect(
    host.contentProvider!.provideTextDocumentContent(
      options.resources[0].originalUri,
      {} as vscode.CancellationToken,
    ),
  ).toBe('before');
  expect(
    host.contentProvider!.provideTextDocumentContent(
      options.resources[0].modifiedUri,
      {} as vscode.CancellationToken,
    ),
  ).toBe('after');
  expect(options.resources[0].originalUri.scheme).toBe('workbench-diff');
  expect(() =>
    host.contentProvider!.provideTextDocumentContent(
      { toString: () => 'file:/etc/passwd' } as vscode.Uri,
      {} as vscode.CancellationToken,
    ),
  ).toThrow('Snapshot expired');
  const dirty = { isDirty: true, uri: { scheme: 'file', fsPath: join(workspace, 'unsaved.ts') } };
  host.documents = [dirty];
  const blocked = provider.controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(10);
  peer.query(peer.requests[9], 'validate_undo', { files: [] });
  await blocked;
  expect(api.window.showWarningMessage).not.toHaveBeenCalled();
  expect(provider.controller.snapshot.error).toContain('dirty editor buffers');
  host.documents = [];
  vi.mocked(api.window.showWarningMessage).mockImplementationOnce(async () => {
    host.documents = [dirty];
    return 'Undo turn' as never;
  });
  const changed = provider.controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(11);
  peer.query(peer.requests[10], 'validate_undo', { files: [] });
  await changed;
  expect(api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  expect(provider.controller.snapshot.error).toContain('dirty editor buffers');
  expect(peer.requests.some((r) => r.command.method === 'undo_turn')).toBe(false);
  // A selected cold session may be outside the current list page. Its attached
  // authoritative view, not the unrelated list window, scopes confirmation.
  host.documents = [];
  const listing = provider.controller.receive({ type: 'refresh_names' });
  await expect.poll(() => peer.requests.length).toBe(12);
  peer.query(peer.requests[11], 'list', { sessions: [], next_cursor: null });
  await listing;
  const outsidePage = provider.controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(13);
  peer.query(peer.requests[12], 'validate_undo', { files: [] });
  await outsidePage;
  expect(api.window.showWarningMessage).toHaveBeenCalledTimes(2);
  expect(provider.controller.snapshot.error).toBeUndefined();
  expect(peer.requests.some((r) => r.command.method === 'undo_turn')).toBe(false);
});
