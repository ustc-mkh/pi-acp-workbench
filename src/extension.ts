import { SessionCoordinator, type SessionHost } from './conversation-session';
import { mergeTranscript } from './transcript-window';
import { modelProvider } from './model-provider';
import { loadEarlier } from './conversation-transcript';
import { TurnCoordinator, type TurnHost } from './conversation-turn';
import { AttachmentCoordinator, type AttachmentHost } from './conversation-attachments';
import { ConversationLifecycle, type RequestGate } from './conversation-lifecycle';
import { parseUiMessage } from './ui-message-schema';
import type { UiPolicy } from './ui-dispatch';
import { dispatchUi, failUi, type UiHandlers } from './ui-dispatch';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { sessionSelectors } from './session-settings';
import { DiffDocuments } from './workspace-documents';
import { StateEncoder } from './state-channel';
import { SessionClient } from './session-wire';
import type { ServiceState } from './session-protocol';
import { initialState } from './state';
import { ActiveConversation } from './active-conversation';
import { ConversationHistory } from './conversation-history';
import { ConversationStatistics } from './conversation-statistics';
import { HARNESS_IDS, isHarnessId, type HarnessId } from './harness';
import { validPrice, type UsageRecord } from './telemetry';
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

export class ChatProvider
  implements vscode.WebviewViewProvider, vscode.Disposable, SessionHost, TurnHost, AttachmentHost
{
  readonly sessionCoordinator: SessionCoordinator = new SessionCoordinator(this);
  readonly turnCoordinator: TurnCoordinator = new TurnCoordinator(this);
  readonly attachmentCoordinator: AttachmentCoordinator = new AttachmentCoordinator(this);
  lifecycle = new ConversationLifecycle();
  view?: vscode.WebviewView;
  stateEncoder = new StateEncoder();
  readonly active = new ActiveConversation();
  get state() {
    return this.active.state;
  }
  get agent() {
    return this.active.agent;
  }
  get cwd() {
    return this.active.cwd;
  }
  get generation() {
    return this.active.generation;
  }
  get contextWindow() {
    return this.active.contextWindow;
  }
  get conversationId() {
    return this.active.conversationId;
  }
  get contextAbort() {
    return this.active.contextAbort;
  }
  harness: HarnessId = 'pi';
  harnessAttachments = new Map<HarnessId, ReturnType<typeof initialState>['attachments']>();
  transientSnapshots = new Map<HarnessId, Snapshot>();

  get replay() {
    return this.lifecycle.replaying;
  }
  set replay(value: boolean) {
    this.lifecycle.replaying = value;
  }
  private timer?: NodeJS.Timeout;
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
  private titleModel = '';
  private titleModelRevision = 0;
  applyServiceState(value: ServiceState) {
    if (value.snapshot.harness !== this.harness || this.state.sessionId !== value.snapshot.id)
      return;
    const s = value.snapshot;
    // The socket decoder preserves unchanged entry identities across state deltas.
    const transcript = mergeTranscript(
      this.state.entries,
      s.entries,
      this.state.historyBefore,
      s.historyBefore,
    );
    this.state.entries = transcript.entries;
    this.state.historyBefore = transcript.before;
    this.state.usage = s.usage;
    this.active.replace({ contextWindow: s.contextWindow ?? s.usage?.size });
    this.state.plan = value.plan || [];
    this.state.sessionNumber = s.sessionNumber;
    this.state.sessionTitle = s.title;
    if (this.history.some((item) => item.id === s.id && item.title !== s.title))
      this.history = this.history.map((item) =>
        item.id === s.id ? { ...item, title: s.title, sessionNumber: s.sessionNumber } : item,
      );
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
        { ...s, entries: [], stored: true, busy: value.busy },
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
        this.active.replace({ contextWindow: value });
        if (this.state.usage) this.state.usage = { ...this.state.usage, size: value };
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
        ({ id, cwd, title, updated, sessionNumber, harness, busy }) => ({
          id,
          cwd,
          title,
          updated,
          sessionNumber,
          harness,
          busy,
        }),
      );
      this.telemetry.sessionMetadata(this.history);
      this.telemetry.models(this.state);
      this.state.titleModel = this.titleModel;
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
      titleModel: this.titleModel,
    });
  }
  private recordUsage(records: UsageRecord[]) {
    return this.telemetry.record(records);
  }
  refreshTelemetry(settledTurn = false) {
    return this.telemetry.refresh(settledTurn);
  }
  disconnect(): void {
    this.sessionCoordinator.disconnect();
  }
  attach(): Promise<void> {
    return this.attachmentCoordinator.attach();
  }
  postOutputImage(reply: import('./shared').OutputImageReply): void {
    void this.view?.webview.postMessage(reply).then(undefined, () => {});
  }
  private handlers: UiHandlers = {
    switchHarness: {
      run: (m) => this.sessionCoordinator.onSwitchHarness(m),
      gated: true,
      navigation: true,
    },
    setVisibleModels: { run: (m) => this.onSetVisibleModels(m) },
    refreshHistory: { run: () => this.onRefreshHistory() },
    releaseSession: { run: (m) => this.sessionCoordinator.onReleaseSession(m), gated: true },
    ready: { run: (m) => this.sessionCoordinator.onReady(m) },
    dismissError: { run: (m) => this.onDismissError(m) },
    deleteHistory: { run: (m) => this.onDeleteHistory(m) },
    clearHistory: { run: (m) => this.onDeleteHistory(m) },
    cancelContext: { run: () => this.onCancelContext() },
    refreshStatistics: { run: () => this.onRefreshStatistics() },
    setPrice: { run: (m) => this.onSetPrice(m) },
    resetProviderModels: {
      run: (m) => this.onResetProvider(m),
      gated: true,
      reportRefusal: true,
      fail: (m, error) => {
        // Keep a partial-progress result already recorded by onResetProvider.
        if (this.state.providerSettingsResult?.id !== m.id)
          this.state.providerSettingsResult = { id: m.id, provider: m.provider, models: [], error };
      },
    },
    setTitleModel: {
      run: async (m) => {
        if (this.harness !== 'pi') throw new Error('请切换到 Pi 选择标题模型。');
        const models = sessionSelectors(this.state)
          .filter((c) => c.kind === 'model')
          .flatMap((c) => c.options.map((o) => o.id));
        if (m.model !== '' && m.model !== 'off' && !models.includes(m.model))
          throw new Error('标题模型不在 Pi 目录中。');
        this.titleModelRevision++;
        const settings = await this.serviceClient.call('setTitleModel', { model: m.model });
        this.titleModel = settings.model;
        this.emit();
      },
      gated: true,
    },
    setModelSettings: {
      run: (m) => this.onSetModelSettings(m),
      gated: true,
      reportRefusal: true,
      fail: (m, error) => {
        this.state.modelSettingsResult = { id: m.id, model: m.model, error };
      },
    },
    logs: { run: () => this.onLogs() },
    login: { run: (m) => this.sessionCoordinator.onLogin(m) },
    cancel: { run: (m) => this.turnCoordinator.onCancel(m) },
    permission: { run: (m) => this.turnCoordinator.onPermission(m) },
    attachmentError: { run: (m) => this.attachmentCoordinator.onAttachmentError(m) },
    attachImages: { run: (m) => this.attachmentCoordinator.onAttachImages(m) },
    attach: { run: () => this.attachmentCoordinator.onAttach() },
    removeAttachment: { run: (m) => this.attachmentCoordinator.onRemoveAttachment(m) },
    open: { run: (m) => this.attachmentCoordinator.onOpen(m) },
    readOutputImage: { run: (m) => this.attachmentCoordinator.onReadOutputImage(m) },
    diff: { run: (m) => this.attachmentCoordinator.onDiff(m) },
    undoTurn: { run: (m) => this.attachmentCoordinator.onUndoTurn(m), gated: true },
    loadEarlier: { run: (m) => loadEarlier(this, m.sessionId), gated: true },
    export: { run: () => this.attachmentCoordinator.onExport() },
    new: { run: (m) => this.sessionCoordinator.onNew(m), gated: true, navigation: true },
    connect: { run: (m) => this.sessionCoordinator.onConnect(m), gated: true },
    branchMessage: { run: (m) => this.sessionCoordinator.onBranchMessage(m), gated: true },
    resume: { run: (m) => this.sessionCoordinator.onResume(m), gated: true, navigation: true },
    preview: { run: (m) => this.sessionCoordinator.onPreview(m), gated: true },
    send: { run: (m) => this.turnCoordinator.onSend(m), gated: true },
    mode: { run: (m) => this.turnCoordinator.onMode(m), gated: true },
    config: { run: (m) => this.turnCoordinator.onConfig(m), gated: true },
    setModelContext: { run: (m) => this.turnCoordinator.onModelContext(m), gated: true },
    refreshModelContexts: {
      run: async (m) => {
        if (
          m.harness !== 'pi' ||
          this.harness !== 'pi' ||
          m.sessionId !== this.state.sessionId ||
          this.state.status !== 'ready'
        )
          return;
        await this.refreshTelemetry(true);
        this.emit();
      },
      gated: true,
    },
  } satisfies UiHandlers;
  private async onSetVisibleModels(
    message: UiMessage & { type: 'setVisibleModels' },
  ): Promise<void> {
    if (message.harness !== this.harness || !isHarnessId(message.harness)) return;
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
      this.active.reset({ harness: this.harness });
      this.telemetry.reset(this.harness);
      this.autoConnectHandled = true;
    }
    this.emit();
  }
  private async onCancelContext(): Promise<void> {
    this.contextAbort?.abort(new Error('已取消操作，原会话保留。'));
  }
  private async onRefreshStatistics(): Promise<void> {
    if (!this.transitioning) {
      const revision = this.titleModelRevision;
      const settings = await this.serviceClient.call('titleSettings');
      if (revision === this.titleModelRevision) this.titleModel = settings.model;
    }
    await this.refreshTelemetry(this.state.status !== 'busy');
    this.emit();
  }
  private async onResetProvider(message: UiMessage & { type: 'resetProviderModels' }) {
    const generation = this.generation,
      completed: string[] = [];
    try {
      if (message.harness !== this.harness || message.sessionId !== this.state.sessionId)
        throw new Error('会话已切换。');
      const models = [
        ...new Set(
          sessionSelectors(this.state)
            .filter((c) => c.kind === 'model')
            .flatMap((c) => c.options.map((o) => o.id)),
        ),
      ].filter((id) => modelProvider(id) === message.provider);
      if (!models.length) throw new Error('供应商没有可修改的模型。');
      const choice = await vscode.window.showWarningMessage(
        `恢复 ${message.provider} 的 ${models.length} 个模型为默认设置？`,
        {
          modal: true,
          detail:
            '恢复四项价格及 Pi context 长度。显示勾选和标题模型选择不变；逐项执行，失败会报告已完成的项目。',
        },
        '全部恢复默认',
      );
      if (choice !== '全部恢复默认') {
        if (generation === this.generation)
          this.state.providerSettingsResult = {
            id: message.id,
            provider: message.provider,
            models: [],
            error: '已取消，设置未修改。',
          };
        return;
      }
      for (const model of models) {
        if (generation !== this.generation) throw new Error('会话已切换。');
        await this.onSetModelSettings({
          type: 'setModelSettings',
          id: `${message.id}:${model}`,
          harness: message.harness,
          sessionId: message.sessionId,
          model,
          values: null,
        });
        completed.push(model);
      }
      this.state.providerSettingsResult = {
        id: message.id,
        provider: message.provider,
        models: completed,
      };
    } catch (error) {
      if (generation === this.generation)
        this.state.providerSettingsResult = {
          id: message.id,
          provider: message.provider,
          models: completed,
          error: `${completed.length} 个已恢复；${String(error)}`,
        };
      throw error;
    } finally {
      if (generation === this.generation) this.emit();
    }
  }
  private async onSetModelSettings(
    message: UiMessage & { type: 'setModelSettings' },
  ): Promise<void> {
    const generation = this.generation;
    let contextSaved = false;
    try {
      if (message.harness !== this.harness || message.sessionId !== this.state.sessionId)
        throw new Error('会话已切换，请重新打开模型设置。');
      if (
        !message.model.trim() ||
        message.model.length > 300 ||
        ['__proto__', 'constructor', 'prototype'].includes(message.model)
      )
        throw new Error('模型标识无效。');
      if (message.values && !validPrice(message.values.price))
        throw new Error('价格必须为非负有限数值。');
      if (this.harness === 'pi') {
        if (!this.state.sessionId || (message.values && message.values.contextWindow === undefined))
          throw new Error('请连接 Pi 并填写 context 长度。');
        await this.turnCoordinator.onModelContext({
          type: 'setModelContext',
          harness: 'pi',
          sessionId: this.state.sessionId,
          model: message.model,
          contextWindow: message.values?.contextWindow ?? null,
        });
        contextSaved = true;
      } else if (message.values?.contextWindow !== undefined) {
        throw new Error('当前 Agent 不支持修改 context 长度。');
      }
      if (generation !== this.generation) throw new Error('会话已切换，设置操作已停止。');
      await this.telemetry.setPrice(message.model, message.values?.price);
      this.state.modelSettingsResult = { id: message.id, model: message.model };
    } catch (error) {
      const detail = `${contextSaved ? 'Context 已更新，但价格未确认保存；请检查后重试。' : ''}${String(error)}`;
      if (generation === this.generation)
        this.state.modelSettingsResult = { id: message.id, model: message.model, error: detail };
      throw new Error(detail);
    } finally {
      if (generation === this.generation) this.emit();
    }
  }
  private async onSetPrice(message: UiMessage & { type: 'setPrice' }): Promise<void> {
    await this.telemetry.setPrice(message.model, message.price);
    this.emit();
  }
  private async onLogs(): Promise<void> {
    this.log.show();
  }
  async perform(message: UiMessage): Promise<void> {
    let gate: RequestGate | undefined;
    let parsed: UiMessage | undefined;
    const generation = this.generation;
    try {
      parsed = parseUiMessage(message);
      if (!parsed) return;
      const policy: UiPolicy = this.handlers[parsed.type];
      const acquired = this.lifecycle.acquire(parsed, policy, {
        ...this.state,
        harness: this.harness,
      });
      if (acquired === false) {
        if (policy.reportRefusal) throw new Error('有其他操作正在进行，请稍后保存。');
        return;
      }
      gate = acquired;
      await this.historyReady;
      if (!this.lifecycle.allowed(policy, { ...this.state, harness: this.harness })) {
        if (policy.reportRefusal) throw new Error('请等待当前任务结束再保存模型设置。');
        return;
      }
      if (policy.gated) this.state.error = undefined;
      await dispatchUi(this.handlers, parsed);
      this.emit();
    } catch (error) {
      const stale = generation !== this.generation;
      if (parsed?.type === 'send' && stale) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (parsed && !stale) failUi(this.handlers, parsed, detail);
      this.state.error =
        detail === 'ACP connection closed' && this.state.error ? this.state.error : detail;
      this.log.appendLine(this.state.error);
      this.emit();
    } finally {
      this.lifecycle.release(gate, generation === this.generation);
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
