import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type * as vscode from 'vscode';
import type { ChatProvider } from '../src/extension';
import type { RemoteAgentOptions } from '../src/remote-agent';
import type { DiffDocuments } from '../src/workspace-documents';
import type { Statistics, UsageRecord } from '../src/telemetry';
import type { Entry } from '../src/shared';
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected fixture value is missing');
  return value;
};
const userEntry = (entries: Entry[]) =>
  required(
    entries.find(
      (entry): entry is Extract<Entry, { role: 'user' | 'assistant' | 'thought' | 'notice' }> =>
        entry.role === 'user',
    ),
  );
// Private state is inspected only at this fixture boundary; public members keep their production types.
type TestProvider = Omit<ChatProvider, 'documents'> & {
  documents: Pick<DiffDocuments, 'open' | 'dispose'> & {
    previews: Map<string, { documents: Map<string, string>; bytes: number }>;
  };
  historyReady: Promise<void>;
  statistics: Statistics;
  recordUsage(records: UsageRecord[]): Promise<void>;
};
type TestContext = Pick<vscode.ExtensionContext, 'subscriptions' | 'workspaceState'>;
const host = vi.hoisted(() => {
  let provider: TestProvider | undefined;
  return {
    get provider() {
      if (!provider) throw new Error('Extension provider has not been registered');
      return provider;
    },
    set provider(value: TestProvider) {
      provider = value;
    },
    config: {} as Record<string, unknown>,
    stored: new Map<string, unknown>(),
    commands: new Map<string, () => unknown>(),
    updates: [] as unknown[],
    configurationChanged: undefined as
      | undefined
      | ((event: vscode.ConfigurationChangeEvent) => void),
    home: undefined as string | undefined,
    cwd: undefined as string | undefined,
    terminals: [] as vscode.TerminalOptions[],
  };
});
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => host.home || os.homedir() };
});
vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { scheme: string; path: string }) => ({
      toString: () => `${parts.scheme}:${parts.path}`,
    }),
  },
  languages: { setTextDocumentLanguage: vi.fn(async (document) => document) },
  workspace: {
    openTextDocument: vi.fn(async (uri) => ({ uri })),
    isTrusted: true,
    get workspaceFolders() {
      return [{ uri: { scheme: 'file', fsPath: host.cwd || process.cwd() } }];
    },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => host.config[key] ?? fallback,
    }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeConfiguration: (callback: (event: vscode.ConfigurationChangeEvent) => void) => {
      host.configurationChanged = callback;
      return { dispose() {} };
    },
  },
  window: {
    showInformationMessage: vi.fn(async () => undefined),
    showTextDocument: vi.fn(async () => {}),
    createTerminal: (options: vscode.TerminalOptions) => {
      host.terminals.push(options);
      return { show() {} };
    },
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
    showWarningMessage: vi.fn(async () => '删除'),
    registerWebviewViewProvider: (_: string, provider: unknown) => {
      host.provider = provider as TestProvider;
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand: (name: string, fn: () => unknown) => {
      host.commands.set(name, fn);
      return { dispose() {} };
    },
    executeCommand: vi.fn(async (..._args: unknown[]) => {}),
  },
}));
import { activate as activateExtension } from '../src/extension';
import { startRustService } from './rust-service';
let service: Awaited<ReturnType<typeof startRustService>>;
let launchFile: string;
// UI tests use the production socket path. Only the upstream ACP worker is mocked.
const activate = (context: TestContext) => {
  activateExtension(context as vscode.ExtensionContext);
  const coordinator = host.provider.sessionCoordinator;
  const create = coordinator.createAgent.bind(coordinator);
  vi.spyOn(coordinator, 'createAgent').mockImplementation((...args) => {
    writeFileSync(launchFile, JSON.stringify(host.config));
    return create(...args);
  });
};
let context: TestContext;
let preferencesHome: string;
beforeEach(async () => {
  preferencesHome = mkdtempSync(resolve(tmpdir(), 'pi-controller-home-'));
  host.home = preferencesHome;
  host.config = {
    sharedHistory: false,
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs')],
  };
  host.stored.clear();
  host.terminals = [];
  context = {
    subscriptions: [],
    workspaceState: {
      keys: () => [...host.stored.keys()],
      get: <T>(key: string, fallback?: T) =>
        (host.stored.has(key) ? host.stored.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => {
        host.stored.set(key, structuredClone(value));
      },
    },
  };
  launchFile = resolve(preferencesHome, 'launch.json');
  host.cwd = preferencesHome;
  writeFileSync(launchFile, JSON.stringify(host.config));
  const worker = (harness: string) => ({
    command: process.execPath,
    args: [resolve('test/controller-worker.mjs'), launchFile, harness],
  });
  service = await startRustService(preferencesHome, {
    command: process.execPath,
    args: [resolve('test/controller-worker.mjs'), launchFile, 'pi'],
    maxWorkers: 2,
    idleMs: 900000,
    harnesses: { codex: worker('codex'), claude: worker('claude') },
  });
  host.config.serviceSocket = service.socket;
  activate(context);
});
afterEach(async () => {
  context.subscriptions.forEach((d: { dispose(): void }) => d.dispose());
  await host.provider.persistence.pending;
  await service.stop();
  host.cwd = undefined;
  host.home = undefined;
  rmSync(preferencesHome, { recursive: true, force: true });
});
const preferences = (harness = 'pi') =>
  JSON.parse(readFileSync(resolve(preferencesHome, 'preferences', `${harness}.json`), 'utf8'))
    .preferences;
function mockHarness(harness: 'codex' | 'claude', mode = '') {
  host.config[harness + '.command'] = process.execPath;
  host.config[harness + '.args'] = [resolve('test/mock-agent.mjs'), mode];
}
it('publishes busy history metadata for concurrent foreground and background sessions', async () => {
  mockHarness('codex');
  await host.provider.perform({ type: 'new' });
  const pi = required(host.provider.state.sessionId);
  const first = host.provider.perform({ type: 'send', text: 'wait' });
  // Initialization/inspection can also be busy: wait for a durable user turn
  // before detaching, not merely a transient busy flag on a slow runner.
  const submitted = (sessionId: string) =>
    vi.waitFor(
      async () => {
        const value = await service.call('state', { sessionId });
        expect(value.busy).toBe(true);
        expect(value.snapshot.entries.some((e) => e.role === 'user' && e.text === 'wait')).toBe(
          true,
        );
      },
      { timeout: 5000 },
    );
  await submitted(pi);
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await first;
  await host.provider.perform({ type: 'new' });
  const codex = required(host.provider.state.sessionId);
  const second = host.provider.perform({ type: 'send', text: 'wait' });
  await submitted(codex);
  await vi.waitFor(
    async () => {
      await host.provider.refreshHistory();
      expect(host.provider.state.history.filter((s) => s.busy)).toHaveLength(2);
    },
    { timeout: 5000 },
  );
  await host.provider.perform({ type: 'cancel' });
  await second;
  await vi.waitFor(() =>
    expect(host.provider.state.history.filter((s) => s.busy).map((s) => s.id)).toEqual([pi]),
  );
  await service.call('cancel', { sessionId: pi });
  await vi.waitFor(async () => {
    await host.provider.refreshHistory();
    expect(host.provider.state.history.some((s) => s.busy)).toBe(false);
  });
});
it('switches harness without auto-creating a session and isolates identical IDs, histories and attachments', async () => {
  mockHarness('codex');
  mockHarness('claude');
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'Pi only' });
  host.provider.state.attachments = [
    { id: 'private', name: 'Pi context', uri: 'file:///private', text: 'do not transfer' },
  ];
  const pi = host.provider.snapshot();
  const create = vi.spyOn(host.provider.sessionCoordinator, 'createAgent');
  create.mockClear();
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  expect(create).not.toHaveBeenCalled();
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'codex',
    status: 'disconnected',
    entries: [],
    attachments: [],
  });
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'Codex only' });
  const codex = host.provider.snapshot();
  expect(codex.sessionId).toBe('workbench:codex:test-session');
  await host.provider.perform({ type: 'switchHarness', harness: 'claude' });
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'Claude only' });
  expect(host.provider.snapshot().sessionId).toBe('workbench:claude:test-session');
  expect(new Set(host.provider.history.map((s) => s.id)).size).toBe(3);
  expect(host.provider.history.map((s) => s.harness).sort()).toEqual(['claude', 'codex', 'pi']);
  await host.provider.perform({ type: 'resume', id: required(pi.sessionId) });
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'pi',
    sessionId: pi.sessionId,
    status: 'ready',
  });
  expect(host.provider.snapshot().attachments).toEqual([
    { id: 'private', name: 'Pi context', uri: 'file:///private', text: 'do not transfer' },
  ]);
  expect(host.provider.snapshot().entries.some((e) => 'text' in e && e.text === 'Codex only')).toBe(
    false,
  );
  expect(host.stored.get('activeSession')).toBe(pi.sessionId);
  expect(host.stored.get('harness.codex.activeSession')).toBe(codex.sessionId);
});
it('keeps model preferences separate while switching away from an active prompt', async () => {
  await contextAgent();
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  mockHarness('codex', 'context');
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().configs!.find((c) => c.id === 'model')!.currentValue).toBe(
    'default',
  );
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  expect(preferences()).not.toEqual(preferences('codex'));
  const id = host.provider.snapshot().sessionId;
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await vi.waitFor(() =>
    expect(host.provider.snapshot().entries.some((entry) => entry.role === 'user')).toBe(true),
  );
  await host.provider.perform({ type: 'switchHarness', harness: 'claude' });
  expect(host.provider.snapshot().harness).toBe('claude');
  await turn;
  await host.provider.perform({ type: 'resume', id: required(id) });
  await host.provider.perform({ type: 'cancel' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('ready'));
  await host.provider.perform({
    type: 'branchMessage',
    sessionId: required(id),
    id: host.provider.snapshot().entries[0].id,
  });
  expect(host.provider.snapshot().error).toContain('暂不支持');
  expect(host.provider.snapshot().sessionId).toBe(id);
});
it.each(['codex', 'claude'] as const)(
  'loads existing %s conversations after release without replacing the ID or entries',
  async (harness) => {
    mockHarness(harness, 'context');
    await host.provider.perform({ type: 'switchHarness', harness });
    await host.provider.perform({ type: 'new' });
    await host.provider.perform({ type: 'send', text: 'keep this conversation' });
    const before = host.provider.snapshot();
    await host.provider.perform({ type: 'releaseSession' });
    await host.provider.perform({ type: 'connect' });
    expect(host.provider.snapshot()).toMatchObject({
      status: 'ready',
      sessionId: before.sessionId,
      entries: before.entries,
      sessionNumber: before.sessionNumber,
    });
    expect(host.provider.history).toHaveLength(1);
    expect(host.provider.snapshot().error).toBeUndefined();
  },
);
it('restores the selected harness after restart and rejects stale cross-harness image messages', async () => {
  mockHarness('codex');
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await host.provider.perform({ type: 'new' });
  const id = host.provider.snapshot().sessionId;
  host.provider.dispose();
  await host.provider.persistence.pending;
  activate(context);
  await host.provider.perform({ type: 'ready' });
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'codex',
    sessionId: id,
    status: 'ready',
  });
  await host.provider.perform({ type: 'attachImages', harness: 'pi', sessionId: id, images: [] });
  expect(host.provider.snapshot().error).toContain('Harness 已切换');
});
it('keeps the old harness usable if saving before a switch fails', async () => {
  await host.provider.perform({ type: 'new' });
  vi.spyOn(host.provider, 'refreshHistory').mockRejectedValueOnce(new Error('storage unavailable'));
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'pi',
    status: 'ready',
    error: 'storage unavailable',
  });
});
it('allows Codex fast mode and keeps collaboration default on creation and load', async () => {
  mockHarness('codex', 'context-codex-options');
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await host.provider.perform({ type: 'new' });
  expect(
    host.provider.snapshot().configs!.find((c) => c.id === 'collaboration_mode')!.currentValue,
  ).toBe('default');
  await host.provider.perform({ type: 'config', id: 'fast-mode', value: 'off' });
  expect(host.provider.snapshot().configs!.find((c) => c.id === 'fast-mode')!.currentValue).toBe(
    'off',
  );
  await host.provider.perform({ type: 'config', id: 'fast-mode', value: 'on' });
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().configs!.find((c) => c.id === 'fast-mode')!.currentValue).toBe(
    'on',
  );
  await host.provider.perform({ type: 'config', id: 'collaboration_mode', value: 'plan' });
  expect(host.provider.snapshot().error).toContain('默认协作模式');
});
it('uses trusted Pi discovery for login even with a workspace-relative PATH entry', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const root = mkdtempSync(resolve(tmpdir(), 'pi-login-security-'));
  const cwd = resolve(root, 'repo');
  const bin = resolve(root, 'trusted');
  mkdirSync(cwd);
  mkdirSync(bin);
  symlinkSync(resolve('test/mock-pi.mjs'), resolve(cwd, 'pi'));
  symlinkSync(resolve('test/mock-pi.mjs'), resolve(bin, 'pi'));
  const previous = host.cwd;
  try {
    host.cwd = cwd;
    vi.stubEnv('PATH', ':' + bin + ':.');
    vi.stubEnv('PI_ACP_PI_COMMAND', undefined);
    await host.provider.perform({ type: 'login' });
    expect(host.terminals.at(-1)).toMatchObject({ shellPath: resolve(bin, 'pi'), cwd });
  } finally {
    host.cwd = previous;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
it('uses harness-specific login commands and never copies Pi profile environment overrides', async () => {
  host.config.env = { PI_ONLY: 'secret' };
  mockHarness('codex');
  host.config['codex.env'] = { CODEX_ONLY: 'value' };
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await host.provider.perform({ type: 'login' });
  expect(host.terminals.at(-1)).toMatchObject({
    shellPath: 'codex',
    shellArgs: ['login'],
  });
  mockHarness('claude');
  await host.provider.perform({ type: 'switchHarness', harness: 'claude' });
  await host.provider.perform({ type: 'login' });
  expect(host.terminals.at(-1)).toMatchObject({
    shellPath: 'claude-agent-acp',
    shellArgs: ['--cli', '/login'],
  });
});
it('honors cancel before prompt submission even after navigation fails', async () => {
  await contextAgent();
  mockHarness('codex');
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(host.provider, 'refreshHistory')
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    )
    .mockRejectedValueOnce(new Error('navigation failed'));
  const sending = host.provider.perform({ type: 'send', text: 'must not be sent' });
  await waiting;
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  expect(host.provider.snapshot().error).toBe('navigation failed');
  await host.provider.perform({ type: 'cancel' });
  release();
  await sending;
  expect(host.provider.snapshot()).toMatchObject({ harness: 'pi', status: 'ready', entries: [] });
  expect(wire().some((r) => r.method === 'session/prompt')).toBe(false);
});
it('locks preview before awaiting persistence', async () => {
  await host.provider.perform({ type: 'new' });
  let release!: () => void;
  vi.spyOn(host.provider, 'refreshHistory').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const preview = host.provider.perform({ type: 'preview' });
  await host.provider.perform({ type: 'send', text: 'must not send' });
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().entries).toEqual([]);
  release();
  await preview;
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', preview: true });
});
it('removes usage titles and does not recreate them after forgetting an active conversation', async () => {
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'private message' });
  await host.provider.recordUsage([]);
  expect(host.stored.get('usageTitles')).toEqual({ 'test-session': 'private message' });
  await host.provider.perform({ type: 'deleteHistory', id: 'test-session' });
  await host.provider.recordUsage([]);
  expect(host.stored.get('usageTitles')).toEqual({});
});
it.each(['codex', 'claude'] as const)(
  'shows %s turn diffs after the answer and opens native changes',
  async (harness) => {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const root = mkdtempSync(resolve(tmpdir(), 'pi-local-diff-'));
    host.cwd = root;
    try {
      execFileSync('git', ['init', '--quiet', root]);
      writeFileSync(resolve(root, 'change.txt'), 'base\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      writeFileSync(resolve(root, 'change.txt'), 'dirty before\n');
      mockHarness(harness, 'context-diff');
      await host.provider.perform({ type: 'switchHarness', harness });
      await host.provider.perform({ type: 'new' });
      await host.provider.perform({ type: 'send', text: 'edit-workspace' });
      const state = host.provider.snapshot(),
        summary = required(state.entries.at(-1));
      expect(state.status).toBe('ready');
      expect(summary.role).toBe('diff');
      if (summary.role !== 'diff') throw new Error('Expected turn diff');
      expect(summary.diff.files[0]).toMatchObject({
        path: 'change.txt',
        before: 'dirty before\n',
        after: 'agent final\n',
      });
      await host.provider.perform({ type: 'diff', id: summary.id, index: -1 });
      const previews = [...host.provider.documents.previews.values()] as {
        documents: Map<string, string>;
      }[];
      expect([...previews.at(-1)!.documents.values()]).toEqual(
        expect.arrayContaining(['dirty before\n', 'agent final\n']),
      );
      const vscode = await import('vscode');
      expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith(
        'vscode.changes',
        '本轮修改',
        expect.any(Array),
      );
      expect(host.provider.snapshot().error).toBeUndefined();
      expect(
        (
          await service.call('state', { sessionId: required(host.provider.snapshot().sessionId) })
        ).snapshot.entries.at(-1)!.role,
      ).toBe('diff');
    } finally {
      host.provider.dispose();
      await host.provider.persistence.pending;
      host.cwd = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('opens saved snapshots for added/deleted files with distinct paths and reports missing text', async () => {
  const vscode = await import('vscode');
  const files = [
    { path: '目录一/公式.md', status: 'added' as const, before: '', after: '新增公式' },
    { path: '目录二/公式.md', status: 'deleted' as const, before: '删除公式', after: '' },
    { path: '目录三/公式.md', status: 'modified' as const, before: '旧公式', after: '新公式' },
    { path: 'binary.png', status: 'modified' as const, omitted: '二进制文件' },
  ].map((file) => ({ ...file, added: 1, removed: 1 }));
  await host.provider.documents.open(
    'test',
    { id: 'native', role: 'diff', text: '', diff: { status: 'partial', files, warnings: [] } },
    -1,
  );
  const [command, title, resources] = vi
    .mocked(vscode.commands.executeCommand)
    .mock.calls.at(-1)! as [
    string,
    string,
    [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][],
  ];
  expect(command).toBe('vscode.changes');
  expect(title).toBe('本轮修改');
  expect(resources).toHaveLength(3);
  const docs = [...host.provider.documents.previews.values()].at(-1) as {
    documents: Map<string, string>;
  };
  expect(resources[0][1]).toBeUndefined();
  expect(docs.documents.get(resources[0][2]!.toString())).toBe('新增公式');
  expect(resources[1][2]).toBeUndefined();
  expect(docs.documents.get(resources[1][1]!.toString())).toBe('删除公式');
  expect(docs.documents.get(resources[2][1]!.toString())).toBe('旧公式');
  expect(docs.documents.get(resources[2][2]!.toString())).toBe('新公式');
  expect(resources.map(([label]) => label.toString())).toEqual([
    expect.stringContaining('/目录一/公式.md'),
    expect.stringContaining('/目录二/公式.md'),
    expect.stringContaining('/目录三/公式.md'),
  ]);
  expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(
    expect.stringContaining('binary.png'),
  );
  vi.mocked(vscode.commands.executeCommand).mockClear();
  await host.provider.documents.open(
    'test',
    {
      id: 'missing',
      role: 'diff',
      text: '',
      diff: { status: 'partial', files: [files[3]], warnings: [] },
    },
    -1,
  );
  expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
});
it('bounds diff document storage and reuses repeated previews', async () => {
  await host.provider.perform({ type: 'new' });
  for (let i = 0; i < 25; i++) {
    const entry: Entry = {
      id: `tool-${i}`,
      role: 'tool',
      tool: {
        toolCallId: `call-${i}`,
        title: 'edit',
        content: [{ type: 'diff', path: 'file.ts', oldText: 'before', newText: 'after' }],
      },
    };
    host.provider.state.entries.push(entry);
    await host.provider.perform({ type: 'diff', id: entry.id, index: 0 });
  }
  expect(host.provider.documents.previews.size).toBe(20);
  const keys = [...host.provider.documents.previews.keys()];
  await host.provider.perform({ type: 'diff', id: 'tool-24', index: 0 });
  expect([...host.provider.documents.previews.keys()]).toEqual(keys);
  expect(keys.some((key) => key.includes('tool-0-'))).toBe(false);
});
it('clears usage titles while preserving billed records and prices', async () => {
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'private message' });
  const record = {
    id: 'request',
    sessionId: 'test-session',
    model: 'model',
    timestamp: Date.now(),
    kind: 'inference',
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  };
  await host.provider.recordUsage([record]);
  const prices = structuredClone(host.provider.statistics.prices);
  await host.provider.perform({ type: 'clearHistory' });
  expect(host.stored.get('usageTitles')).toEqual({});
  expect(host.stored.get('usageRecords')).toEqual([record]);
  expect(host.provider.statistics.prices).toEqual(prices);
});
it('does not create a session on ready, reconnect, or send; only explicit new does', async () => {
  const start = vi.spyOn(host.provider.sessionCoordinator, 'start');
  await Promise.all([
    host.provider.perform({ type: 'ready' }),
    host.provider.perform({ type: 'ready' }),
  ]);
  await host.provider.perform({ type: 'connect' });
  await host.provider.perform({ type: 'send', text: 'hello' });
  expect(start).not.toHaveBeenCalled();
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', entries: [] });
  await host.provider.perform({ type: 'new' });
  const id = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'ready' });
  await host.provider.perform({ type: 'connect' });
  expect(host.provider.snapshot().sessionId).toBe(id);
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
  await host.provider.perform({ type: 'dismissError', error: required(error) });
  expect(host.provider.snapshot()).toMatchObject({ status: 'busy', error: undefined });
  await host.provider.perform({ type: 'attach' });
  expect(host.provider.snapshot().error).toBeTruthy();
  await host.provider.perform({ type: 'cancel' });
  await turn;
});
it('keeps an explicitly opened offline preview disconnected', async () => {
  await host.provider.perform({ type: 'preview' });
  await host.provider.perform({ type: 'ready' });
  expect(host.provider.snapshot()).toMatchObject({ status: 'disconnected', preview: true });
  expect(host.provider.snapshot().connectionAttempted).toBeFalsy();
});
it('runs a complete turn through the controller, saves history, and loads it', async () => {
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().status).toBe('ready');
  await host.provider.perform({ type: 'send', text: 'hello' });
  const state = host.provider.snapshot();
  expect(state.status).toBe('ready');
  expect(state.entries).toContainEqual(
    expect.objectContaining({ role: 'assistant', text: '数学 $x^2$' }),
  );
  expect(
    (await service.call('state', { sessionId: required(host.provider.snapshot().sessionId) }))
      .snapshot.title,
  ).toBe('hello');
  await host.provider.perform({ type: 'resume', id: 'test-session' });
  expect(host.provider.snapshot().entries[0]).toMatchObject({ role: 'user', text: 'hello' });
});
it('serializes concurrent new requests without orphaning a process', async () => {
  await Promise.all([
    host.provider.perform({ type: 'new' }),
    host.provider.perform({ type: 'new' }),
  ]);
  expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().error).toBeUndefined();
});
it('reserves guarded requests before history loads, rejects overlapping sends, and releases after failure', async () => {
  await host.provider.perform({ type: 'new' });
  let release!: () => void;
  const history = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = vi.spyOn(host.provider, 'historyReady', 'get').mockReturnValue(history);
  const send = vi
    .spyOn(host.provider.turnCoordinator, 'onSend')
    .mockRejectedValueOnce(new Error('submission failed'));
  const first = host.provider.perform({ type: 'send', text: 'first' });
  const second = host.provider.perform({ type: 'send', text: 'second' });
  release();
  await Promise.all([first, second]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(host.provider.snapshot().error).toBe('submission failed');
  ready.mockRestore();
  send.mockRestore();
  await host.provider.perform({ type: 'send', text: 'after failure' });
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().entries).toContainEqual(
    expect.objectContaining({ role: 'user', text: 'after failure' }),
  );
});
it('submits only one of two simultaneous prompts', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await host.provider.perform({ type: 'send', text: 'second' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await vi.waitFor(() =>
    expect(host.provider.snapshot().entries.filter((e) => e.role === 'user')).toHaveLength(1),
  );
  await host.provider.perform({ type: 'cancel' });
  await turn;
  expect(host.provider.snapshot().entries.filter((e) => e.role === 'user')).toEqual([
    expect.objectContaining({ text: 'wait' }),
  ]);
});
it('cancels pending permission requests when the user stops', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  await host.provider.perform({ type: 'cancel' });
  await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0);
  expect(host.provider.snapshot().status).toBe('ready');
  expect(
    host.provider
      .snapshot()
      .entries.some((entry) => entry.role === 'notice' && entry.text.includes('cancelled')),
  ).toBe(true);
  expect(host.provider.snapshot().entries.at(-1)!.role).toBe('diff');
});
it('rejects forged permission option IDs and accepts the displayed option', async () => {
  await host.provider.perform({ type: 'new' });
  const turn = host.provider.perform({ type: 'send', text: 'permission' });
  await vi.waitFor(() => expect(host.provider.snapshot().permissions).toHaveLength(1));
  const id = host.provider.snapshot().permissions[0].id;
  await host.provider.perform({ type: 'permission', id, optionId: 'invented' });
  expect(host.provider.snapshot().permissions).toHaveLength(1);
  await host.provider.perform({ type: 'permission', id, optionId: 'yes' });
  await turn;
  expect(host.provider.snapshot().permissions).toHaveLength(0);
  expect(host.provider.snapshot().status).toBe('ready');
});
it('creates and switches sessions while the original turn keeps running in the daemon', async () => {
  await contextAgent();
  const original = host.provider.snapshot().sessionId!;
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await vi.waitFor(() =>
    expect(host.provider.snapshot().entries.some((entry) => entry.role === 'user')).toBe(true),
  );
  await host.provider.perform({ type: 'resume', id: original });
  expect(host.provider.snapshot()).toMatchObject({ sessionId: original, status: 'busy' });
  await host.provider.perform({ type: 'new' });
  const second = host.provider.snapshot().sessionId!;
  expect(second).not.toBe(original);
  expect(host.provider.snapshot().status).toBe('ready');
  await turn;
  expect(
    (await host.provider.serviceClient.call<{ busy: boolean }>('state', { sessionId: original }))
      .busy,
  ).toBe(true);
  await host.provider.perform({ type: 'send', text: 'second' });
  expect(host.provider.snapshot().entries).toContainEqual(
    expect.objectContaining({ role: 'user', text: 'second' }),
  );
  await host.provider.perform({ type: 'resume', id: original });
  expect(host.provider.snapshot()).toMatchObject({ sessionId: original, status: 'busy' });
  await host.provider.perform({ type: 'send', text: 'blocked overlap' });
  expect(host.provider.snapshot().entries.filter((e) => e.role === 'user')).toHaveLength(1);
  await host.provider.perform({ type: 'resume', id: second });
  expect(host.provider.snapshot()).toMatchObject({
    sessionId: second,
    status: 'ready',
    error: undefined,
  });
  await host.provider.perform({ type: 'resume', id: original });
  await host.provider.perform({ type: 'cancel' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('ready'));
});
it('switches harness during a live turn without cancelling it or retaining the old request gate', async () => {
  await host.provider.perform({ type: 'new' });
  const original = host.provider.snapshot().sessionId!;
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await vi.waitFor(() =>
    expect(host.provider.snapshot().entries.some((entry) => entry.role === 'user')).toBe(true),
  );
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  await turn;
  expect(host.provider.snapshot().harness).toBe('codex');
  expect(
    (await host.provider.serviceClient.call<{ busy: boolean }>('state', { sessionId: original }))
      .busy,
  ).toBe(true);
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'codex second' });
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'codex',
    status: 'ready',
    error: undefined,
  });
  await host.provider.perform({ type: 'resume', id: original });
  expect(host.provider.snapshot()).toMatchObject({
    harness: 'pi',
    sessionId: original,
    status: 'busy',
  });
  await host.provider.perform({ type: 'cancel' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('ready'));
});
it('retains the busy session and original request gate when navigation fails before detaching', async () => {
  await contextAgent();
  const original = host.provider.snapshot().sessionId!;
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() =>
    expect(host.provider.snapshot().entries.some((entry) => entry.role === 'user')).toBe(true),
  );
  const refresh = vi
    .spyOn(host.provider, 'refreshHistory')
    .mockRejectedValueOnce(new Error('history unavailable'));
  await host.provider.perform({ type: 'switchHarness', harness: 'codex' });
  expect(host.provider.snapshot()).toMatchObject({
    sessionId: original,
    harness: 'pi',
    status: 'busy',
    error: 'history unavailable',
  });
  refresh.mockRestore();
  await host.provider.perform({ type: 'send', text: 'blocked overlap' });
  expect(host.provider.snapshot().entries.filter((entry) => entry.role === 'user')).toHaveLength(1);
  await host.provider.perform({ type: 'cancel' });
  await turn;
  expect(host.provider.snapshot().status).toBe('ready');
});
it('keeps the daemon connected after worker failure and surfaces an actionable error', async () => {
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'crash' });
  expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().error).toBeTruthy();
});
it('does not persist conversation content when history is disabled', async () => {
  host.config.persistHistory = false;
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'hello' });
  expect(host.stored.get('history')).toBeUndefined();
});
it('keeps cleared history empty after another automatic save', async () => {
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'clearHistory' });
  await host.provider.perform({ type: 'send', text: 'hello' });
  expect(host.stored.get('history')).toBeUndefined();
});

let auditDir: string | undefined;
afterEach(() => {
  if (auditDir) {
    rmSync(auditDir, { recursive: true, force: true });
    auditDir = undefined;
  }
});
async function contextAgent(mode = 'context') {
  auditDir = mkdtempSync(resolve(tmpdir(), 'pi-context-test-'));
  host.config.args = [resolve('test/mock-agent.mjs'), mode];
  host.config.env = { PI_TEST_AUDIT: resolve(auditDir, 'wire.jsonl') };
  await host.provider.perform({ type: 'new' });
}
it('assigns distinct native branch numbers without replacing the source backend', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'same title' });
  const original = host.provider.snapshot();
  expect(original.sessionNumber).toBe(1);
  await host.provider.perform({
    type: 'branchMessage',
    sessionId: required(original.sessionId),
    id: original.entries[0].id,
  });
  const branch = host.provider.snapshot();
  expect(branch.sessionNumber).toBe(2);
  expect(host.provider.history.map((s) => s.title)).toEqual(['same title', 'same title']);
});
function wire() {
  return readFileSync(resolve(auditDir!, 'wire.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
async function edit(type: 'branchMessage', id: string) {
  await host.provider.perform({
    type,
    id,
    sessionId: required(host.provider.snapshot().sessionId),
  });
}
it('branches at the native node, keeps historical settings, and never sends a textual seed or summary request', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'retained-first' });
  const old = host.provider.snapshot(),
    selected = required(old.entries.find((e) => e.role === 'assistant'));
  await host.provider.perform({ type: 'send', text: 'excluded-later' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  await edit('branchMessage', selected.id);
  const branch = host.provider.snapshot();
  expect(branch.error).toBeUndefined();
  expect(branch.sessionId).not.toBe(old.sessionId);
  expect(branch.entries).toEqual(old.entries.slice(0, 2));
  expect(branch.usage).toBeUndefined();
  expect(branch.configs!.map((c) => c.currentValue)).toEqual(['default', 'low']);
  expect(
    (await service.call('state', { sessionId: old.sessionId })).snapshot.entries.some(
      (e) => 'text' in e && e.text === 'excluded-later',
    ),
  ).toBe(true);
  expect(wire().filter((r) => r.method === 'session/prompt')).toHaveLength(2);
  expect(wire().filter((r) => r.method === 'session/load')).toHaveLength(2); // Source and newly attached branch load independently.
  expect(wire().filter((r) => r.method === 'session/new')).toHaveLength(1);
  expect(wire().some((r) => r.method === '_pi_workbench/summarize')).toBe(false);
  await host.provider.perform({ type: 'send', text: 'continue-here' });
  const prompt = wire()
    .filter((r) => r.method === 'session/prompt')
    .at(-1).params;
  expect(prompt.sessionId).toBe(branch.sessionId);
  expect(prompt.prompt).toEqual([{ type: 'text', text: 'continue-here' }]);
  await host.provider.perform({ type: 'send', text: 'one-more' });
  expect(
    wire()
      .filter((r) => r.method === 'session/prompt')
      .at(-1).params.prompt,
  ).toEqual([{ type: 'text', text: 'one-more' }]);
});
it('preserves the visible transcript across native load and never re-injects it on a branch', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'uncompacted-history' });
  const original = host.provider.snapshot();
  host.provider.disconnect();
  host.provider.state.status = 'disconnected';
  await host.provider.perform({ type: 'resume', id: required(original.sessionId) });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  await edit('branchMessage', original.entries[1].id);
  await host.provider.perform({ type: 'send', text: 'continue' });
  const seed = wire()
    .filter((r) => r.method === 'session/prompt')
    .at(-1).params.prompt[0].text;
  expect(seed).toBe('continue');
});
it('retains the original session and its usable agent when native forking fails', async () => {
  await contextAgent('context-native-fail');
  await host.provider.perform({ type: 'send', text: 'original' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  const original = host.provider.snapshot();
  await edit('branchMessage', original.entries[0].id);
  expect(host.provider.snapshot()).toMatchObject({
    sessionId: original.sessionId,
    entries: original.entries,
    status: 'ready',
  });
  expect(host.provider.snapshot().error).toBeTruthy();
  await host.provider.perform({ type: 'send', text: 'still-usable' });
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().status).toBe('ready');
});
it('blocks stale branch actions, branching during generation, and unlocatable display messages', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'original' });
  const original = host.provider.snapshot();
  await host.provider.perform({
    type: 'branchMessage',
    id: original.entries[0].id,
    sessionId: 'stale-session',
  });
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  const turn = host.provider.perform({ type: 'send', text: 'wait' });
  await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
  await edit('branchMessage', original.entries[0].id);
  expect(host.provider.snapshot().entries[0]).toEqual(original.entries[0]);
  await host.provider.perform({ type: 'cancel' });
  await turn;
  host.provider.state.entries.push({ id: 'unmapped', role: 'user', text: 'not in native history' });
  await edit('branchMessage', 'unmapped');
  expect(host.provider.snapshot().sessionId).toBe(original.sessionId);
  expect(host.provider.snapshot().error).toContain('无法唯一');
});
it('never falls back to large textual reconstruction when an adapter lacks native fork support', async () => {
  await contextAgent();
  host.provider.state.entries = [{ id: 'large', role: 'user', text: 'x'.repeat(2_010_000) }];
  const original = host.provider.snapshot();
  await edit('branchMessage', 'large');
  expect(host.provider.snapshot().error).toContain('不支持原生分支');
  expect(host.provider.snapshot().entries).toEqual(original.entries);
  expect(host.provider.snapshot().sessionId).toBe(original.sessionId);
});

it('deduplicates billed requests and keeps native branch spending separate', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'original' });
  const original = host.provider.snapshot().sessionId;
  const record = {
    id: 'native-request',
    sessionId: required(original),
    model: 'p/m',
    timestamp: Date.now(),
    kind: 'inference',
    input: 100,
    output: 20,
    cacheRead: 80,
    cacheWrite: 0,
  };
  await host.provider.recordUsage([record]);
  await host.provider.recordUsage([record]);
  expect(host.stored.get('usageRecords')).toHaveLength(1);
  await host.provider.recordUsage([
    { ...record, id: 'next-request', sessionId: required(host.provider.snapshot().sessionId) },
  ]);
  expect((host.stored.get('usageRecords') as UsageRecord[]).map((r) => r.sessionId)).toEqual([
    original,
    original,
  ]);
  await edit('branchMessage', host.provider.snapshot().entries[0].id);
  await host.provider.recordUsage([
    { ...record, id: 'branch-request', sessionId: required(host.provider.snapshot().sessionId) },
  ]);
  expect(
    (host.stored.get('usageRecords') as UsageRecord[]).find((r) => r.id === 'branch-request')!
      .sessionId,
  ).not.toBe(original);
});
it('cancels native branch preparation without discarding the original connection', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'original' });
  const before = host.provider.snapshot(),
    agent = required(host.provider.agent),
    request = agent.request.bind(agent);
  let rejectFork: ((e: Error) => void) | undefined;
  vi.spyOn(agent, 'request').mockImplementation((method, params) => {
    if (method === '_pi_workbench/fork')
      return new Promise((_, reject) => {
        rejectFork = reject;
      });
    if (method === '_pi_workbench/cancel_fork') {
      rejectFork?.(new Error('cancelled native fork'));
      return Promise.resolve({});
    }
    return request(method, params);
  });
  const operation = edit('branchMessage', before.entries[1].id);
  await vi.waitFor(() => expect(rejectFork).toBeDefined());
  expect(host.provider.snapshot().contextOperation).toEqual({ kind: 'fork' });
  await host.provider.perform({ type: 'cancelContext' });
  await operation;
  expect(host.provider.snapshot().contextOperation).toBeUndefined();
  expect(host.provider.snapshot()).toMatchObject({
    status: 'ready',
    sessionId: before.sessionId,
    entries: before.entries,
  });
  expect(host.provider.agent).toBe(agent);
  expect(wire().some((r) => r.method === '_pi_workbench/summarize')).toBe(false);
});
it('does not resurrect a deleted conversation when a native branch fails late', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'original' });
  const provider = host.provider;
  const before = provider.snapshot();
  const agent = required(provider.agent);
  const request = agent.request.bind(agent);
  let rejectFork!: (error: Error) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(agent, 'request').mockImplementation((method, params) => {
    if (method !== '_pi_workbench/fork') return request(method, params);
    return new Promise((_, reject) => {
      rejectFork = reject;
      entered();
    });
  });
  const branch = edit('branchMessage', before.entries[1].id);
  await waiting;
  await provider.perform({ type: 'clearHistory' });
  rejectFork(new Error('stale branch failure'));
  await branch;
  expect(provider.snapshot()).toMatchObject({ status: 'disconnected', entries: [] });
  expect(provider.snapshot().sessionId).toBeUndefined();
  expect(provider.snapshot().error).toBeUndefined();
  expect(provider.cwd).toBe('');
  expect(provider.conversationId).toBeUndefined();
  expect(provider.contextAbort).toBeUndefined();
});
it('keeps a source disconnect during native branching disconnected and reconnectable', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'send', text: 'original' });
  const provider = host.provider,
    before = provider.snapshot(),
    agent = required(provider.agent);
  const request = agent.request.bind(agent);
  vi.spyOn(agent, 'request').mockImplementation((method, params) => {
    if (method !== '_pi_workbench/fork') return request(method, params);
    agent.dispose();
    (agent as unknown as { options: RemoteAgentOptions }).options.closed(
      'source disconnected during fork',
    );
    return Promise.reject(new Error('ACP connection closed'));
  });
  await edit('branchMessage', before.entries[1].id);
  expect(provider.snapshot()).toMatchObject({
    status: 'disconnected',
    sessionId: before.sessionId,
    entries: before.entries,
  });
  expect(provider.snapshot().contextOperation).toBeUndefined();
  expect(provider.agent).toBeUndefined();
  await provider.perform({ type: 'connect' });
  expect(provider.snapshot()).toMatchObject({ status: 'ready', sessionId: before.sessionId });
});
it('explicit statistics refresh and restoring prices request a live Pi catalogue without prompting the model', async () => {
  await contextAgent('context-native');
  await host.provider.perform({ type: 'refreshStatistics' });
  expect(
    wire()
      .filter((r) => r.method === '_pi_workbench/inspect')
      .at(-1).params.force,
  ).toBe(true);
  await host.provider.perform({ type: 'setPrice', model: 'openai/m' });
  expect(
    wire()
      .filter((r) => r.method === '_pi_workbench/inspect')
      .at(-1).params.force,
  ).toBe(true);
  expect(wire().some((r) => r.method === 'session/prompt')).toBe(false);
});
it('persists custom prices, rejects invalid numbers and restores defaults', async () => {
  await host.provider.perform({
    type: 'setPrice',
    model: 'p/m',
    price: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  expect(host.stored.get('prices')).toMatchObject({ 'p/m': { input: 2 } });
  await host.provider.perform({
    type: 'setPrice',
    model: 'p/m',
    price: { input: -1, output: 3, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  expect(host.stored.get('prices')).toMatchObject({ 'p/m': { input: 2 } });
  await host.provider.perform({ type: 'setPrice', model: 'p/m' });
  expect(host.stored.get('prices')).toEqual({});
});
const pastedPng = {
  name: 'clipboard.png',
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
};
it('sends image-only messages as ACP image blocks and preserves the original image in local history', async () => {
  await contextAgent('context-images');
  const sessionId = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'attachImages', sessionId, images: [pastedPng] });
  expect(host.provider.snapshot().attachments[0].kind).toBe('image');
  await host.provider.perform({ type: 'send', text: '' });
  const prompt = wire()
    .filter((r) => r.method === 'session/prompt')
    .at(-1).params.prompt;
  expect(prompt).toEqual([{ type: 'image', mimeType: pastedPng.mimeType, data: pastedPng.data }]);
  expect(host.provider.snapshot().attachments).toEqual([]);
  expect(userEntry(host.provider.snapshot().entries).contextBlocks).toEqual(prompt);
  expect(
    userEntry((await service.call('state', { sessionId })).snapshot.entries).contextBlocks,
  ).toEqual(prompt);
});
it('retains image drafts when the agent lacks image support and permits removal', async () => {
  await contextAgent();
  const sessionId = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'attachImages', sessionId, images: [pastedPng] });
  await host.provider.perform({ type: 'send', text: 'image' });
  expect(host.provider.snapshot().error).toContain('未声明图片支持');
  expect(wire().some((r) => r.method === 'session/prompt')).toBe(false);
  const id = host.provider.snapshot().attachments[0].id;
  await host.provider.perform({ type: 'removeAttachment', id });
  expect(host.provider.snapshot().attachments).toEqual([]);
});
it('rejects stale image pastes and validates an entire batch before adding any attachment', async () => {
  await contextAgent();
  const sessionId = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'attachImages', sessionId: 'stale', images: [pastedPng] });
  expect(host.provider.snapshot().attachments).toEqual([]);
  await host.provider.perform({
    type: 'attachImages',
    sessionId,
    images: [pastedPng, { ...pastedPng, mimeType: 'image/svg+xml' }],
  });
  expect(host.provider.snapshot().attachments).toEqual([]);
});

it('inherits model then thinking after model-dependent options change, without setting duplicate modes', async () => {
  await contextAgent('context-dependent');
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  const old = host.provider.snapshot().sessionId,
    before = wire().length;
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().error).toBeUndefined();
  expect(host.provider.snapshot().sessionId).not.toBe(old);
  expect(host.provider.snapshot().configs!.map((c) => c.currentValue)).toEqual(['other', 'high']);
  expect(
    wire()
      .slice(before)
      .filter((r) => r.method.startsWith('session/set_'))
      .map((r) => r.params),
  ).toEqual([
    { sessionId: required(host.provider.snapshot().sessionId), configId: 'model', value: 'other' },
    {
      sessionId: required(host.provider.snapshot().sessionId),
      configId: 'thinking',
      value: 'high',
    },
  ]);
});
it('persists successful selections immediately and inherits them after restart even without history', async () => {
  host.config.persistHistory = false;
  await contextAgent();
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'config', id: 'thinking', value: 'high' });
  expect(preferences()).toEqual([
    { kind: 'model', value: 'other' },
    { kind: 'thinking', value: 'high' },
  ]);
  host.stored.clear(); // A different workspace has no workspaceState preferences/history.
  host.provider.dispose();
  await host.provider.persistence.pending;
  activate(context);
  const before = wire().length;
  await host.provider.perform({ type: 'ready' });
  expect(wire().length).toBe(before);
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().configs!.map((c) => c.currentValue)).toEqual(['other', 'high']);
});
it('does not save a rejected model selection as the account default', async () => {
  await contextAgent('context-config-fail');
  const saved = preferences();
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  expect(host.provider.snapshot()).toMatchObject({ status: 'ready', error: 'config rejected' });
  expect(preferences()).toEqual(saved);
});
it('reads the latest account pair instead of the currently displayed conversation when creating', async () => {
  await contextAgent();
  expect(host.provider.snapshot().configs![0].currentValue).toBe('default');
  writeFileSync(
    resolve(preferencesHome, 'preferences', 'pi.json'),
    JSON.stringify({
      version: 1,
      preferences: [
        { kind: 'model', value: 'other' },
        { kind: 'thinking', value: 'high' },
      ],
    }),
  );
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().configs!.map((c) => c.currentValue)).toEqual(['other', 'high']);
});
it('resumes the last active warm conversation after restart, and reconnects it without session/new', async () => {
  await contextAgent();
  const first = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'send', text: 'first' });
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'resume', id: required(first) });
  expect(host.stored.get('activeSession')).toBe(first);
  host.provider.dispose();
  await host.provider.persistence.pending;
  activate(context);
  const before = wire().length;
  await host.provider.perform({ type: 'ready' });
  expect(host.provider.snapshot()).toMatchObject({ status: 'ready', sessionId: first });
  host.provider.disconnect();
  host.provider.state.status = 'disconnected';
  await host.provider.perform({ type: 'connect' });
  expect(
    wire()
      .slice(before)
      .filter((r) => r.method === 'session/new'),
  ).toHaveLength(0);
  expect(
    wire()
      .slice(before)
      .filter((r) => r.method === 'session/load')
      .map((r) => r.params.sessionId),
  ).toEqual([]); // The service keeps the warm worker across client reconnection.
});
it('does not overwrite account preferences by merely reopening an older conversation', async () => {
  await contextAgent();
  const first = host.provider.snapshot().sessionId;
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'config', id: 'model', value: 'other' });
  await host.provider.perform({ type: 'resume', id: required(first) });
  expect(host.provider.snapshot().configs![0].currentValue).toBe('default');
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().configs![0].currentValue).toBe('other');
});
it('does not auto-open a different history after deleting the last active record', async () => {
  await contextAgent();
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({
    type: 'deleteHistory',
    id: required(host.provider.snapshot().sessionId),
  });
  host.provider.dispose();
  await host.provider.persistence.pending;
  activate(context);
  const before = wire().length;
  await host.provider.perform({ type: 'ready' });
  expect(host.provider.snapshot().sessionId).toBeUndefined();
  expect(wire().length).toBe(before);
});
it('warns about unavailable inherited values without retrying or silently creating extra sessions', async () => {
  await contextAgent();
  host.provider.dispose();
  await host.provider.persistence.pending;
  writeFileSync(
    resolve(preferencesHome, 'preferences', 'pi.json'),
    JSON.stringify({
      version: 1,
      preferences: [
        { kind: 'model', value: 'removed-model' },
        { kind: 'thinking', value: 'removed-level' },
      ],
    }),
  );
  activate(context);
  const before = wire().length;
  await host.provider.perform({ type: 'new' });
  expect(host.provider.snapshot().status).toBe('ready');
  expect(host.provider.snapshot().entries).toContainEqual(
    expect.objectContaining({
      role: 'notice',
      text: expect.stringContaining('上次的设置当前不可用'),
    }),
  );
  expect(
    wire()
      .slice(before)
      .filter((r) => r.method === 'session/new'),
  ).toHaveLength(1);
});

it('uses the production remote Pi client and receives phone turns without owning a process', async () => {
  const { startRustService } = await import('./rust-service');
  const { SessionClient } = await import('../src/session-wire');
  host.provider.dispose();
  await host.provider.persistence.pending;
  const root = mkdtempSync(resolve(tmpdir(), 'pi-remote-controller-')),
    socket = resolve(root, 'service', 'sessions.sock');
  host.config = { sharedHistory: false, serviceSocket: socket };
  host.stored.clear();
  let service: Awaited<ReturnType<typeof startRustService>> | undefined;
  const phone = new SessionClient(socket);
  try {
    service = await startRustService(root, {
      command: process.execPath,
      args: [resolve('test/mock-agent.mjs'), 'context-native'],
      env: { PI_TEST_AUDIT: resolve(root, 'audit.jsonl') },
      maxWorkers: 1,
      idleMs: 900000,
    });
    expect(service.socket).toBe(socket);
    activateExtension(context as vscode.ExtensionContext);
    await host.provider.historyReady;
    await host.provider.perform({ type: 'new' });
    expect(host.provider.snapshot().status).toBe('ready');
    const id = host.provider.snapshot().sessionId;
    let release!: () => void, submitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    host.provider.view = {
      webview: {
        postMessage: async (message: { type: string }) => {
          if (message.type === 'sent') {
            submitted();
            await gate;
          }
          return true;
        },
      },
    } as unknown as vscode.WebviewView;
    const sending = host.provider.perform({ type: 'send', text: 'cancel before submission' });
    await sent;
    await host.provider.perform({ type: 'cancel' });
    release();
    await sending;
    host.provider.view = undefined;
    expect(host.provider.snapshot().status).toBe('ready');
    expect((await phone.call('state', { sessionId: id })).snapshot.entries).toHaveLength(0);
    await host.provider.perform({ type: 'send', text: 'desktop-owned' });
    const serverState = await phone.call('state', { sessionId: id });
    expect(host.provider.snapshot().entries.map((entry) => entry.id)).toEqual(
      serverState.snapshot.entries.map((entry) => entry.id),
    );

    await phone.call(
      'prompt',
      { sessionId: id, prompt: [{ type: 'text', text: 'from phone' }] },
      undefined,
      0,
    );
    await vi.waitFor(() =>
      expect(
        host.provider.snapshot().entries.some((e) => 'text' in e && e.text === 'from phone'),
      ).toBe(true),
    );
    expect(host.provider.snapshot().status).toBe('ready');
    const turn = phone.call(
      'prompt',
      { sessionId: id, prompt: [{ type: 'text', text: 'wait' }] },
      undefined,
      0,
    );
    await vi.waitFor(() => expect(host.provider.snapshot().status).toBe('busy'));
    await host.provider.perform({ type: 'cancel' });
    expect((await turn).stopReason).toBe('cancelled');
    expect('child' in host.provider.agent!).toBe(false);
  } finally {
    host.provider.dispose();
    phone.dispose();
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
it('persists model visibility per harness and rejects stale page submissions', async () => {
  host.config.args = [resolve('test/mock-agent.mjs'), 'context'];
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({
    type: 'setVisibleModels',
    harness: 'pi',
    models: ['other', 'invalid', 'other'],
  });
  expect(host.provider.snapshot().visibleModels).toEqual(['other']);
  expect(host.stored.get('visibleModels')).toEqual({ pi: ['other'] });
  await host.provider.perform({ type: 'setVisibleModels', harness: 'codex', models: [] });
  expect(host.stored.get('visibleModels')).toEqual({ pi: ['other'] });
  await host.provider.perform({ type: 'setVisibleModels', harness: 'pi', models: null });
  expect(host.provider.snapshot().visibleModels).toBeUndefined();
});
it('restores locally persisted context occupancy after extension restart', async () => {
  host.config.args = [resolve('test/mock-agent.mjs'), 'context-live'];
  await host.provider.perform({ type: 'new' });
  await host.provider.perform({ type: 'send', text: 'usage' });
  expect(host.provider.snapshot().usage).toEqual({ used: 1234, size: 200000 });
  host.provider.dispose();
  await host.provider.persistence.pending;
  activate(context);
  await host.provider.historyReady;
  await host.provider.perform({ type: 'connect' });
  expect(host.provider.snapshot().usage).toEqual({ used: 1234, size: 200000 });
});
