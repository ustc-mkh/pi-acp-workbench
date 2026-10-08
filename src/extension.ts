import { SessionCoordinator } from './conversation-session';
import { TurnCoordinator } from './conversation-turn';
import { AttachmentCoordinator } from './conversation-attachments';
import { ConversationLifecycle } from './conversation-lifecycle';
import { dispatchUi, type UiHandlers } from './ui-dispatch';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { sessionSelectors } from './session-settings';
import { DiffDocuments } from './workspace-documents';
import { StateEncoder } from './state-channel';
import { RemoteAgent, type Agent } from './remote-agent';
import { SessionClient } from './session-wire';
import type { ServiceState } from './session-protocol';
import { initialState } from './state';
import { ConversationHistory } from './conversation-history';
import { ConversationStatistics } from './conversation-statistics';
import { HARNESS_IDS, isHarnessId, type HarnessId } from './harness';
import type { UsageRecord } from './telemetry';
import type { Snapshot, UiMessage } from './shared';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('piAcp.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const command = (name: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  command('piAcp.open', () => vscode.commands.executeCommand('piAcp.chat.focus'));
  command('piAcp.newSession', () => provider.perform({ type: 'new' }));
  command('piAcp.attachSelection', () => provider.attach());
  command('piAcp.login', () => provider.perform({ type: 'login' }));
  command('piAcp.preview', () => provider.perform({ type: 'preview' }));
  command('piAcp.logs', () => provider.perform({ type: 'logs' }));
  return { getState: () => provider.snapshot() };
}

export class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly sessionCoordinator: SessionCoordinator = new SessionCoordinator(this);
  readonly turnCoordinator: TurnCoordinator = new TurnCoordinator(this);
  readonly attachmentCoordinator: AttachmentCoordinator = new AttachmentCoordinator(this);
  lifecycle = new ConversationLifecycle();
  view?: vscode.WebviewView;
  stateEncoder = new StateEncoder();
  state = initialState();
  harness: HarnessId = 'pi';
  harnessAttachments = new Map<HarnessId, ReturnType<typeof initialState>['attachments']>();
  transientSnapshots = new Map<HarnessId, Snapshot>();
  agent?: Agent;
  cwd = '';
  get replay() {
    return this.lifecycle.replaying;
  }
  set replay(value: boolean) {
    this.lifecycle.replaying = value;
  }
  generation = 0;
  private timer?: NodeJS.Timeout;
  private requestInFlight = false;
  get stopping() {
    return this.lifecycle.cancelled;
  }
  private get prompting() {
    return this.lifecycle.prompting;
  }
  get transitioning() {
    return this.lifecycle.transitioning;
  }
  autoConnectHandled = false;
  private historyStore: ConversationHistory;
  get history() {
    return this.historyStore.items;
  }
  set history(items: Snapshot[]) {
    this.historyStore.items = items;
  }
  private get historyReady() {
    return this.historyStore.ready;
  }
  get persistence() {
    return this.historyStore.persistence;
  }
  get forgottenSessions() {
    return this.historyStore.forgotten;
  }
  private get disposed() {
    return this.lifecycle.disposed;
  }
  contextWindow?: number;
  conversationId?: string;
  contextAbort?: AbortController;
  telemetry: ConversationStatistics;
  private get statistics() {
    return this.telemetry.value;
  }
  get inspecting() {
    return this.telemetry.pending;
  }
  documents = new DiffDocuments();
  private resources: vscode.Disposable[] = [];
  private get modelStorage() {
    return this.context.globalState || this.context.workspaceState;
  }
  private visibleModels() {
    return this.modelStorage.get<Partial<Record<HarnessId, string[]>>>('visibleModels', {})[
      this.harness
    ];
  }
  serviceClient = new SessionClient();
  applyServiceState(value: ServiceState) {
    if (value.snapshot.harness !== this.harness || this.state.sessionId !== value.snapshot.id)
      return;
    const s = value.snapshot;
    // The socket decoder preserves unchanged entry identities across state deltas.
    this.state.entries = s.entries;
    this.state.usage = s.usage;
    this.contextWindow = s.contextWindow ?? s.usage?.size;
    this.state.plan = value.plan || [];
    this.state.sessionNumber = s.sessionNumber;
    this.state.configs = s.configs;
    this.state.modes = s.modes;
    this.state.nativeForks = s.nativeForks;
    this.state.permissions = value.permissions;
    this.state.commands = value.commands;
    this.state.contextComplete = s.contextComplete;
    this.state.status = value.busy ? 'busy' : 'ready';
    this.state.error = value.error;
    if (this.config.get('persistHistory', true) && !this.forgottenSessions.has(s.id))
      this.history = [
        { ...s, entries: [], stored: true },
        ...this.history.filter((h) => h.id !== s.id),
      ];
    this.emit();
  }
  private log = vscode.window.createOutputChannel('Pi Agent');
  constructor(readonly context: vscode.ExtensionContext) {
    const selected = context.workspaceState.get('selectedHarness', 'pi');
    if (isHarnessId(selected)) this.harness = selected;
    this.state.harness = this.harness;
    this.serviceClient = new SessionClient(this.config.get<string>('serviceSocket') || undefined);
    this.historyStore = new ConversationHistory({
      storage: context.workspaceState,
      enabled: () => this.config.get('persistHistory', true),
      current: () => this.state,
      changed: () => this.emit(),
      error: (error) => {
        this.log.appendLine(`[history] ${String(error)}`);
        this.state.error = String(error);
        this.emit();
      },
      remote: {
        list: () => this.serviceClient.call<Snapshot[]>('list'),
        remove: (id) =>
          this.serviceClient.call('historyRemove', id ? { sessionId: id } : {}, undefined, 0),
      },
    });
    this.telemetry = new ConversationStatistics(
      context.workspaceState,
      this.persistence,
      () => ({
        agent: this.agent,
        state: this.state,
        harness: this.harness,
        conversationId: this.conversationId,
        retained:
          this.config.get('persistHistory', true) &&
          !this.forgottenSessions.has(this.state.sessionId || ''),
      }),
      (value) => {
        this.contextWindow = value;
      },
      () => this.emit(),
    );
    this.historyStore.start();
    if (!this.config.get('persistHistory', true)) this.disableHistory();
    this.resources.push(
      this.log,
      this.documents,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('piAcp')) return;
        if (!this.config.get('persistHistory', true)) this.disableHistory();
        else if (e.affectsConfiguration('piAcp.persistHistory')) {
          void this.historyStore.initialize();
        }
        this.emit();
      }),
    );
  }
  get config() {
    return vscode.workspace.getConfiguration('piAcp');
  }
  private disableHistory() {
    this.telemetry.forget();
    void this.historyStore
      .disable(async () => {
        await this.telemetry.persistTitles();
      })
      .catch((error) => {
        this.state.error = String(error);
        this.emit();
      });
  }
  private refreshSharedHistory() {
    return this.historyStore.refresh();
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.stateEncoder.reset();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    const uri = (file: string) =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    const nonce = randomBytes(24).toString('base64');
    view.webview.html = /* HTML */ `<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; script-src 'nonce-${nonce}' ${view.webview
              .cspSource}; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view
              .webview.cspSource}; img-src ${view.webview.cspSource} data:; connect-src 'none';"
          />
          <link rel="stylesheet" href="${uri('katex.min.css')}" />
          <link rel="stylesheet" href="${uri('style.css')}" />
        </head>
        <body>
          <div id="app"></div>
          <script type="module" nonce="${nonce}" src="${uri('webview.js')}"></script>
        </body>
      </html>`;
    const listener = view.webview.onDidReceiveMessage((message) => void this.perform(message));
    view.onDidDispose(() => {
      listener.dispose();
      this.view = undefined;
    });
    this.emit();
  }
  emit() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.state.harness = this.harness;
      this.state.history = this.history.map(
        ({ id, cwd, title, updated, sessionNumber, harness }) => ({
          id,
          cwd,
          title,
          updated,
          sessionNumber,
          harness,
        }),
      );
      this.telemetry.models(this.state);
      this.state.statistics = this.statistics;
      this.state.showThoughts = this.config.get('showThoughts', true);
      this.state.visibleModels = this.visibleModels();
      if (this.view) {
        void this.view.webview.postMessage(this.stateEncoder.encode(this.state)).then(
          (delivered) => {
            if (!delivered) this.stateEncoder.reset();
          },
          () => this.stateEncoder.reset(),
        );
      }
    }, 40);
  }
  async refreshHistory() {
    // Session data is authoritative on the daemon; refresh only the client index.
    await this.historyStore.refresh();
  }
  snapshot() {
    return structuredClone({
      ...this.state,
      harness: this.harness,
      visibleModels: this.visibleModels(),
    });
  }
  start(target: Snapshot | 'new'): Promise<void> {
    return this.sessionCoordinator.start(target);
  }
  createAgent(cwd: string): RemoteAgent {
    return this.sessionCoordinator.createAgent(cwd);
  }
  private recordUsage(records: UsageRecord[]) {
    return this.telemetry.record(records);
  }
  refreshTelemetry(settledTurn = false) {
    return this.telemetry.refresh(settledTurn);
  }
  cancelPermissions() {
    this.state.permissions = [];
  }
  disconnect(): void {
    this.sessionCoordinator.disconnect();
  }
  attach(): Promise<void> {
    return this.attachmentCoordinator.attach();
  }
  private handlers = {
    switchHarness: (message) => this.sessionCoordinator.onSwitchHarness(message),
    setVisibleModels: (message) => this.onSetVisibleModels(message),
    refreshHistory: () => this.onRefreshHistory(),
    releaseSession: (message) => this.sessionCoordinator.onReleaseSession(message),
    ready: (message) => this.sessionCoordinator.onReady(message),
    dismissError: (message) => this.onDismissError(message),
    deleteHistory: (message) => this.onDeleteHistory(message),
    clearHistory: (message) => this.onDeleteHistory(message),
    copyConversation: (message) => this.attachmentCoordinator.onCopyConversation(message),
    cancelContext: () => this.onCancelContext(),
    refreshStatistics: () => this.onRefreshStatistics(),
    setPrice: (message) => this.onSetPrice(message),
    logs: () => this.onLogs(),
    login: (message) => this.sessionCoordinator.onLogin(message),
    cancel: (message) => this.turnCoordinator.onCancel(message),
    permission: (message) => this.turnCoordinator.onPermission(message),
    attachmentError: (message) => this.attachmentCoordinator.onAttachmentError(message),
    attachImages: (message) => this.attachmentCoordinator.onAttachImages(message),
    attach: (message) => this.attachmentCoordinator.onAttach(message),
    removeAttachment: (message) => this.attachmentCoordinator.onRemoveAttachment(message),
    open: (message) => this.attachmentCoordinator.onOpen(message),
    diff: (message) => this.attachmentCoordinator.onDiff(message),
    export: (message) => this.attachmentCoordinator.onExport(message),
    new: (message) => this.sessionCoordinator.onNew(message),
    connect: (message) => this.sessionCoordinator.onConnect(message),
    branchMessage: (message) => this.sessionCoordinator.onBranchMessage(message),
    resume: (message) => this.sessionCoordinator.onResume(message),
    preview: (message) => this.sessionCoordinator.onPreview(message),
    send: (message) => this.turnCoordinator.onSend(message),
    mode: (message) => this.turnCoordinator.onMode(message),
    config: (message) => this.turnCoordinator.onConfig(message),
  } satisfies UiHandlers;
  private async onSetVisibleModels(
    message: UiMessage & { type: 'setVisibleModels' },
  ): Promise<void> {
    if (message.harness !== this.harness || !isHarnessId(message.harness)) return;
    if (
      message.models !== null &&
      (!Array.isArray(message.models) ||
        message.models.length > 10000 ||
        !message.models.every((id) => typeof id === 'string' && id.length <= 10000))
    )
      throw new Error('模型列表格式无效。');
    const catalog = new Set(
      sessionSelectors(this.state)
        .filter((c) => c.kind === 'model')
        .flatMap((c) => c.options.map((o) => o.id)),
    );
    const saved = {
      ...this.modelStorage.get<Partial<Record<HarnessId, string[]>>>('visibleModels', {}),
    };
    if (message.models === null) delete saved[this.harness];
    else saved[this.harness] = [...new Set(message.models)].filter((id) => catalog.has(id));
    await this.modelStorage.update('visibleModels', saved);
    this.emit();
  }
  private async onRefreshHistory(): Promise<void> {
    await this.refreshSharedHistory();
    this.emit();
  }
  private async onDismissError(message: UiMessage & { type: 'dismissError' }): Promise<void> {
    // A click on an older banner must not dismiss a newer error in flight.
    if (this.state.error === message.error) this.state.error = undefined;
    this.emit();
  }
  private async onDeleteHistory(
    message: UiMessage & { type: 'deleteHistory' | 'clearHistory' },
  ): Promise<void> {
    if (
      (await vscode.window.showWarningMessage(
        message.type === 'clearHistory'
          ? '清空此服务器账户的全部共享会话？所有客户端都会失去这些历史记录，所有正在运行的任务（包括 Telegram）都会停止。'
          : '删除此共享会话？所有客户端都会失去这条历史记录。',
        { modal: true },
        '删除',
      )) !== '删除'
    )
      return;
    if (message.type === 'deleteHistory') {
      const forgotten = this.history.find((item) => item.id === message.id);
      if (!forgotten) return;
      this.telemetry.forget(forgotten.conversationId || forgotten.id);
    } else {
      this.telemetry.forget();
    }
    const deletedState = this.state;
    const deletesCurrent =
      message.type === 'clearHistory' ||
      (message.type === 'deleteHistory' && message.id === deletedState.sessionId);
    await this.historyStore.remove(
      message.type === 'deleteHistory' ? message.id : undefined,
      async () => {
        await this.telemetry.persistTitles();
        for (const harness of HARNESS_IDS)
          if (
            message.type === 'clearHistory' ||
            (message.type === 'deleteHistory' &&
              this.transientSnapshots.get(harness)?.id === message.id)
          )
            this.transientSnapshots.delete(harness);
      },
    );
    if (deletesCurrent && this.state === deletedState) {
      this.disconnect();
      this.cwd = '';
      this.contextWindow = undefined;
      this.conversationId = undefined;
      this.state = { ...initialState(), harness: this.harness };
      this.telemetry.reset(this.harness);
      this.autoConnectHandled = true;
    }
    this.emit();
  }
  private async onCancelContext(): Promise<void> {
    this.contextAbort?.abort(new Error('已取消操作，原会话保留。'));
  }
  private async onRefreshStatistics(): Promise<void> {
    await this.refreshTelemetry();
    this.emit();
  }
  private async onSetPrice(message: UiMessage & { type: 'setPrice' }): Promise<void> {
    await this.telemetry.setPrice(message.model, message.price);
    this.emit();
  }
  private async onLogs(): Promise<void> {
    this.log.show();
  }
  async perform(message: UiMessage): Promise<void> {
    let ownsGate = false;
    try {
      if (
        !message ||
        typeof message !== 'object' ||
        typeof message.type !== 'string' ||
        !Object.hasOwn(this.handlers, message.type)
      )
        return;
      const gated = [
        'new',
        'connect',
        'branchMessage',
        'resume',
        'preview',
        'send',
        'mode',
        'config',
        'switchHarness',
        'releaseSession',
      ].includes(message.type);
      if (gated) {
        if (this.requestInFlight) return;
        this.requestInFlight = true;
        ownsGate = true;
      }
      await this.historyReady;
      if (this.disposed) return;
      if (gated) {
        if (
          this.transitioning ||
          this.state.status === 'busy' ||
          this.state.status === 'connecting'
        )
          return;
        this.state.error = undefined;
      }
      await dispatchUi(this.handlers, message);
      this.emit();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.state.error =
        detail === 'ACP connection closed' && this.state.error ? this.state.error : detail;
      this.log.appendLine(this.state.error);
      this.emit();
    } finally {
      if (ownsGate) this.requestInFlight = false;
    }
  }
  dispose() {
    if (this.disposed) return;
    void this.refreshHistory().catch(() => {});
    this.disconnect();
    this.lifecycle.dispose();
    this.serviceClient.dispose();
    this.historyStore.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.resources.forEach((r) => r.dispose());
  }
}
