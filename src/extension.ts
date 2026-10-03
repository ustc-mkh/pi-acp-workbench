import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { codexFixedConfigs, sessionPreferences, type SessionPreference } from './session-settings';
import { applyPreferences, restoreSettings } from './session-configuration';
import {bindNativeForks} from './native-branch';
import { SessionCache } from './session-cache';
import { StateEncoder } from './state-channel';
import { validateImage, MAX_ATTACHMENT_IMAGE_BYTES } from './images';
import { AgentProcess } from './agent';
import { applyUpdate, initialState, nextId } from './state';
import { contextSeed, checkPromptSize } from './context';
import { SnapshotStore } from './snapshots';
import { HistoryPersistence } from './history-persistence';
import { HARNESSES, HARNESS_IDS, harnessKey, isHarnessId, snapshotHarness, launchSettings, type HarnessId } from './harness';
import { allocateSessionNumber, migrateSessionNumbers } from './session-numbers';
import { SharedHistoryStore, SessionInUseError } from './shared-history';
import { prepareContext, contextBudget, checkpoint, byteSize, type Checkpoint } from './checkpoints';
import { mergeUsage, validPrice, priceFor, type Inspection, type Statistics, type Price, type UsageRecord } from './telemetry';
import { presetPrices } from './prices';
import { demoMarkdown } from './demo';
import type { Entry, Snapshot, UiMessage } from './shared';

function metadataDeadline<T>(request:Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('用量读取超时，请稍后刷新。')),10000);request.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatProvider(context);
  context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider('piAcp.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }));
  const command = (name: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  command('piAcp.open', () => vscode.commands.executeCommand('piAcp.chat.focus'));
  command('piAcp.newSession', () => provider.perform({ type: 'new' }));
  command('piAcp.attachSelection', () => provider.attach());
  command('piAcp.login', () => provider.perform({ type: 'login' }));
  command('piAcp.preview', () => provider.perform({ type: 'preview' }));
  command('piAcp.logs', () => provider.perform({ type: 'logs' }));
  return { getState: () => provider.snapshot() };
}

interface CachedConversation {agent:AgentProcess;state:ReturnType<typeof initialState>;cwd:string;checkpoints:Checkpoint[];contextWindow?:number;conversationId?:string}

class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private sessions=new SessionCache<CachedConversation>();
  private activeCacheable=true;
  private view?: vscode.WebviewView;
  private stateEncoder = new StateEncoder();
  private state = initialState();
  private harness: HarnessId = 'pi';
  private harnessAttachments = new Map<HarnessId, ReturnType<typeof initialState>['attachments']>();
  private transientSnapshots = new Map<HarnessId, Snapshot>();
  private agent?: AgentProcess;
  private cwd = '';
  private replay = false;
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private cancelTimer?: NodeJS.Timeout;
  private stopping = false;
  private prompting = false;
  private transitioning = false;
  private autoConnectHandled = false;
  private history: Snapshot[];
  private snapshots: SnapshotStore;
  private sharedHistory?: SharedHistoryStore;
  private historyReady: Promise<void> = Promise.resolve();
  private historyPoll?: NodeJS.Timeout;
  private activeLease?: string;
  private disposed = false;
  private persistence: HistoryPersistence;
  private checkpoints: Checkpoint[] = [];
  private contextWindow?: number;
  private conversationId?: string;
  private contextAbort?: AbortController;
  private statistics: Statistics;
  private priceOverrides: Record<string, Price>;
  private modelPrices: Record<string, Price> = {};
  private inspecting?: Promise<void>;
  private forgottenSessions = new Set<string>();
  private permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();
  private diffDocs = new Map<string, string>();
  private resources: vscode.Disposable[] = [];
  private log = vscode.window.createOutputChannel('Pi Agent');
  constructor(private context: vscode.ExtensionContext) {
    const selected = context.workspaceState.get('selectedHarness','pi');
    if (isHarnessId(selected)) this.harness = selected;
    this.state.harness = this.harness;
    const legacy = new SnapshotStore(context.storageUri?.fsPath ? path.join(context.storageUri.fsPath, 'conversations') : undefined);
    if (this.config.get('sharedHistory', true)) {
      this.sharedHistory = new SharedHistoryStore(path.join(homedir(), '.pi', 'pi-acp-workbench', 'history'), id => {
        if (this.activeLease !== id) return;
        this.disconnect(); this.state.status = 'disconnected'; this.state.readOnly = true;
        this.state.error = '共享会话锁已失效，已停止本窗口的 Agent。请重新连接。'; this.emit();
      });
    }
    this.snapshots = this.sharedHistory || legacy;
    this.persistence = new HistoryPersistence(this.snapshots, !!this.sharedHistory);
    this.priceOverrides = context.workspaceState.get('prices', {});
    this.statistics = {records:mergeUsage([],context.workspaceState.get('usageRecords',[])),prices:{...presetPrices,...this.priceOverrides},titles:context.workspaceState.get('usageTitles',{}),available:false};
    this.history = this.config.get<boolean>('persistHistory', true) ? context.workspaceState.get<Snapshot[]>('history', []) : [];
    if (this.sharedHistory) {
      this.historyReady = this.initializeSharedHistory(legacy).catch(error => { this.state.error = String(error); this.emit(); });
      this.historyPoll = setInterval(() => { void this.refreshSharedHistory().catch(error => { this.state.error = String(error); this.emit(); }); }, 5000);
      this.historyPoll.unref();
    }
    if (!this.sharedHistory) this.historyReady = this.initializeLocalNumbers().catch(error => { this.state.error = String(error); this.emit(); });
    if (!this.config.get('persistHistory', true)) this.disableHistory();
    this.resources.push(this.log, vscode.workspace.registerTextDocumentContentProvider('pi-acp-diff', {
      provideTextDocumentContent: uri => this.diffDocs.get(uri.toString()) || '',
    }), vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('piAcp')) return;
      if(['command','args','env','useBundledAdapter','codex','claude'].some(key=>e.affectsConfiguration('piAcp.'+key))){this.sessions.clear();this.activeCacheable=false;}
      if (!this.config.get('persistHistory', true)) this.disableHistory();
      else if (this.sharedHistory && e.affectsConfiguration('piAcp.persistHistory')) {
        this.historyReady = this.historyReady.then(() => this.initializeSharedHistory(legacy)).catch(error => { this.state.error = String(error); this.emit(); });
      }
      this.emit();
    }));
  }
  private get config() { return vscode.workspace.getConfiguration('piAcp'); }
  private disableHistory() {
    this.persistence.invalidate();
    this.history = [];
    this.statistics = {...this.statistics, titles:{}};
    this.sessions.clear();
    void this.persistence.enqueue(async () => {
      if (!this.sharedHistory) await this.context.workspaceState.update('history', undefined);
      for (const harness of HARNESS_IDS) await this.context.workspaceState.update(harnessKey('activeSession',harness), null);
      await this.context.workspaceState.update('usageTitles', {});
      // Opting out on one client must not erase other clients' shared history.
      if (!this.sharedHistory) await this.snapshots.clear();
    }).catch(error => { this.state.error = String(error); this.emit(); });
  }
  private async initializeLocalNumbers() {
    const index = {sessions:this.history,nextSessionNumber:this.context.workspaceState.get<number>('nextSessionNumber',1)};
    if (migrateSessionNumbers(index)) {
      await this.context.workspaceState.update('nextSessionNumber',index.nextSessionNumber);
      await this.context.workspaceState.update('history',this.history);
    }
  }
  private async initializeSharedHistory(legacy: SnapshotStore) {
    if (!this.sharedHistory || !this.config.get('persistHistory', true)) return;
    if (!this.context.workspaceState.get('sharedHistoryMigrated', false)) {
      for (const index of this.context.workspaceState.get<Snapshot[]>('history', [])) await this.sharedHistory.import(await legacy.read(index));
      await this.context.workspaceState.update('sharedHistoryMigrated', true);
      await this.context.workspaceState.update('history', undefined);
      // Keep the old files as migration backups; they are no longer read after the marker.
    }
    this.history = await this.sharedHistory.list();
    this.emit();
  }
  private async refreshSharedHistory() {
    await this.historyReady;
    if (!this.sharedHistory || this.disposed || !this.config.get('persistHistory', true)) return;
    await this.persistence.enqueue(async () => {
      const history = await this.sharedHistory!.list();
      if (this.disposed || !this.config.get('persistHistory', true)) return;
      const id = this.state.sessionId, previous = this.history.find(s => s.id === id);
      if (id && previous && !history.some(s => s.id === id)) this.forgottenSessions.add(id);
      if (this.state.readOnly && id) {
        const item = history.find(s => s.id === id);
        if (item && item.revision !== previous?.revision) this.state.entries = (await this.snapshots.read(item)).entries;
      }
      this.history = history;
      this.emit();
    });
  }
  private releaseLease() {
    const id = this.activeLease;
    this.activeLease = undefined;
    if (id && this.sharedHistory) void this.persistence.enqueue(() => this.sharedHistory!.release(id)).catch(error => this.log.appendLine(String(error)));
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.stateEncoder.reset();
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    const nonce = randomBytes(24).toString('base64');
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${uri('katex.min.css')}"><link rel="stylesheet" href="${uri('style.css')}"></head><body><div id="app"></div><script nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage(message => void this.perform(message));
    view.onDidDispose(() => { listener.dispose(); this.view = undefined;this.sessions.clear(); });
    this.emit();
  }
  private emit() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.state.harness = this.harness;
      this.state.history = this.history.map(({ id, cwd, title, updated, sessionNumber, harness }) => ({ id, cwd, title, updated, sessionNumber, harness:harness || snapshotHarness({id}) }));
      const models=this.state.configs?.filter(c=>c.category==='model'||c.id==='model').flatMap(c=>c.type==='select'?c.options.flatMap(o=>'options' in o?o.options:[o]):[]).map(o=>({id:o.value,name:o.name}));
      if ((this.state.status==='ready'||this.state.status==='busy') && JSON.stringify(models || []) !== JSON.stringify(this.statistics.models)) {
        this.statistics = {...this.statistics, models:models || []};
      }
      this.state.statistics = this.statistics;
      this.state.showThoughts = this.config.get('showThoughts', true);
      if (this.view) {
        void this.view.webview.postMessage(this.stateEncoder.encode(this.state)).then(delivered => {
          if (!delivered) this.stateEncoder.reset();
        }, () => this.stateEncoder.reset());
      }
    }, 40);
  }
  private async save() {
    if (!this.state.sessionId || this.state.preview || this.state.readOnly || this.forgottenSessions.has(this.state.sessionId) || !this.config.get('persistHistory', true)) return;
    const epoch = this.persistence.epoch;
    const title = this.state.entries.find(e => e.role === 'user');
    const snapshot: Snapshot = {
      id: this.state.sessionId, harness:this.harness, sessionNumber:this.state.sessionNumber, cwd: this.cwd, title: title && title.role === 'user' ? title.text.slice(0, 70) : '新对话',
      updated: Date.now(), entries: structuredClone(this.state.entries), nativeForks:structuredClone(this.state.nativeForks),
      contextComplete: this.state.contextComplete, contextPending: this.state.contextPending,
      configs: structuredClone(this.state.configs), modes: structuredClone(this.state.modes),
      checkpoints:structuredClone(this.checkpoints),contextWindow:this.contextWindow,conversationId:this.conversationId,
    };
    await this.persistence.enqueue(async()=>{
      if (epoch !== this.persistence.epoch) return;
      if (!this.sharedHistory) {
        const numbering = {sessions:this.history,nextSessionNumber:this.context.workspaceState.get<number>('nextSessionNumber',1)};
        snapshot.sessionNumber ??= allocateSessionNumber(numbering,snapshot);
        await this.context.workspaceState.update('nextSessionNumber',numbering.nextSessionNumber);
      }
      const index = await this.persistence.write(snapshot, epoch, () =>
        !this.forgottenSessions.has(snapshot.id) && this.config.get('persistHistory', true));
      if (!index) return;
      if (this.state.sessionId === index.id) this.state.sessionNumber = index.sessionNumber;
      const next=[index,...this.history.filter(s=>s.id!==index.id)];
      if (this.sharedHistory) {
        const history = await this.sharedHistory.list();
        if (epoch !== this.persistence.epoch || !this.config.get('persistHistory', true)) return;
        this.history = history;
      }
      else {
        this.history=next.slice(0,20);
        await this.context.workspaceState.update('history',this.history);
        for(const old of next.slice(20))await this.snapshots.remove(old.id);
      }
      this.emit();
    });
  }

  /** null means deliberately no active history; undefined migrates pre-0.2.2 installations. */
  private lastSnapshot() {
    const id = this.context.workspaceState.get<string | null>(harnessKey('activeSession',this.harness));
    const local = this.history.filter(s => {
      try { return snapshotHarness(s) === this.harness && vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === s.cwd); }
      catch { return false; }
    });
    return id === undefined ? local[0] : local.find(s => s.id === id);
  }
  private currentSnapshot(): Snapshot | undefined {
    if (!this.state.sessionId || this.state.preview) return this.lastSnapshot() || this.transientSnapshots.get(this.harness);
    return { id:this.state.sessionId, harness:this.harness, sessionNumber:this.state.sessionNumber, cwd:this.cwd, title:'', updated:Date.now(), entries:this.state.entries,
      contextComplete:this.state.contextComplete, contextPending:this.state.contextPending, nativeForks:this.state.nativeForks,
      configs:this.state.configs, modes:this.state.modes, checkpoints:this.checkpoints,
      contextWindow:this.contextWindow, conversationId:this.conversationId };
  }
  private async readSnapshot(snapshot: Snapshot) {
    // Unsaved in-memory context belongs to our leased session, not to a stale disk snapshot.
    if (this.sharedHistory && !snapshot.stored && !this.state.readOnly && snapshot.id === this.state.sessionId) return structuredClone(snapshot);
    const data = await this.snapshots.read(snapshot);
    if (snapshotHarness(data) !== snapshotHarness(snapshot)) throw new Error('历史记录的 harness 不匹配，未启动 Agent。');
    return {...data,sessionNumber:data.sessionNumber ?? snapshot.sessionNumber};
  }
  private async rememberSettings() {
    if (this.state.preview || !this.state.sessionId) return;
    await this.context.workspaceState.update(harnessKey('sessionPreferences',this.harness), sessionPreferences(this.state));
  }
  private async rememberActive() {
    await this.rememberSettings();
    const id = this.state.sessionId;
    await this.context.workspaceState.update(harnessKey('activeSession',this.harness), id && this.config.get('persistHistory', true) && !this.forgottenSessions.has(id) ? id : null);
  }
  private async workspaceCwd() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，才能启动本地 Agent。');
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先在 VS Code 打开一个本地项目文件夹。');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: `选择 ${HARNESSES[this.harness].name} 的工作目录` });
    if (!folder) throw new Error('未选择工作目录。');
    if (folder.uri.scheme !== 'file') throw new Error('请在本地或 Remote/SSH 扩展宿主中打开文件工作区。');
    return folder.uri.fsPath;
  }
  snapshot() { return structuredClone({...this.state,harness:this.harness}); }
  private async selectHarness(harness: HarnessId) {
    if (harness === this.harness) return;
    if (this.inspecting) await this.inspecting;
    await this.save();
    if (this.state.sessionId && !this.state.preview) {
      const snapshot = this.currentSnapshot();
      if (snapshot) this.transientSnapshots.set(this.harness,structuredClone(snapshot));
      if (!this.state.readOnly) await this.rememberActive();
    }
    this.harnessAttachments.set(this.harness,this.state.attachments);
    this.disconnect(); this.releaseLease(); this.sessions.clear(); await this.persistence.pending;
    this.harness = harness; this.cwd = ''; this.checkpoints = []; this.contextWindow = undefined; this.conversationId = undefined;
    this.state = {...initialState(),harness,attachments:this.harnessAttachments.get(harness) || []};
    this.statistics = {...this.statistics, available:false, models:[], note:harness==='pi'?undefined:HARNESSES[harness].note};
    this.autoConnectHandled = true;
    await this.context.workspaceState.update('selectedHarness',harness);
    const previous = this.lastSnapshot() || this.transientSnapshots.get(harness);
    if (previous) {
      const snapshot = previous.stored ? await this.snapshots.read(previous) : previous;
      this.cwd = snapshot.cwd; this.checkpoints = snapshot.checkpoints || []; this.contextWindow = snapshot.contextWindow; this.conversationId = snapshot.conversationId;
      this.state = {...this.state,sessionId:snapshot.id,sessionNumber:snapshot.sessionNumber,entries:structuredClone(snapshot.entries),configs:snapshot.configs,modes:snapshot.modes,
        contextComplete:snapshot.contextComplete,contextPending:snapshot.contextPending,readOnly:true,connectionAttempted:true};
    }
    this.emit();
  }
  private async start(target: Snapshot | 'new') {
    if (this.transitioning) return;
    this.autoConnectHandled = true;
    this.state.connectionAttempted = true;
    this.transitioning = true;
    try { await this.startSession(target); } finally { this.transitioning = false; }
  }
  private async startSession(target: Snapshot | 'new') {
    let snapshot = target === 'new' ? undefined : target;
    if (this.state.status === 'busy' || this.state.status === 'connecting') return;
    if (snapshot && snapshotHarness(snapshot) !== 'pi' && snapshot.contextPending) throw new Error('此 harness 不支持待重建上下文，只能在原支持的客户端恢复或复制记录后显式新建。');
    if (snapshot && snapshotHarness(snapshot) !== this.harness) await this.selectHarness(snapshotHarness(snapshot));
    if(snapshot?.id===this.state.sessionId && this.agent&&!this.agent.isClosed&&this.state.status==='ready')return;
    const cwd = snapshot?.cwd || await this.workspaceCwd();
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    if (snapshot && !vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === cwd)) {
      if (!this.sharedHistory) throw new Error('请先打开该历史会话对应的工作区。');
      await this.save(); this.parkActive();
      snapshot = await this.snapshots.read(snapshot); this.cwd = cwd;
      this.state = {...initialState(), sessionId:snapshot.id, sessionNumber:snapshot.sessionNumber, entries:structuredClone(snapshot.entries), contextComplete:snapshot.contextComplete,
        readOnly:true, connectionAttempted:true, error:'只读查看：请打开此会话对应的工作区后再继续对话。'};
      this.emit(); return;
    }
    if(this.inspecting)await this.inspecting;
    let cached=snapshot?this.sessions.take(snapshot.id):undefined;
    if(!cached&&snapshot){snapshot=await this.readSnapshot(snapshot);if(snapshot.contextPending)contextSeed(snapshot.entries,snapshot.contextComplete);}
    try{await this.save();}catch(error){if(cached)this.sessions.put(snapshot!.id,cached,this.cacheBytes(cached));throw error;}
    if(cached?.agent.isClosed){cached=undefined;snapshot=await this.readSnapshot(snapshot!);if(snapshot.contextPending)contextSeed(snapshot.entries,snapshot.contextComplete);}
    const attachments = !this.state.sessionId || snapshot?.id === this.state.sessionId ? this.state.attachments : [];
    const preferences = sessionPreferences(this.state).length && !this.state.preview
      ? sessionPreferences(this.state)
      : this.context.workspaceState.get<SessionPreference[]>(harnessKey('sessionPreferences',this.harness), sessionPreferences(this.lastSnapshot() || {}));
    this.parkActive();
    if(cached){
      this.agent=cached.agent;this.activeCacheable=true;this.state=cached.state;this.cwd=cached.cwd;this.checkpoints=cached.checkpoints;this.contextWindow=cached.contextWindow;this.conversationId=cached.conversationId;this.replay=false;
      this.state.status='ready';await this.rememberActive();this.emit();return;
    }
    if (this.sharedHistory && snapshot) {
      await this.persistence.pending.catch(() => {});
      try {
        await this.sharedHistory.claim(snapshot.id); this.activeLease = snapshot.id;
        snapshot = await this.readSnapshot(snapshot);
      } catch (error) {
        this.releaseLease();
        if (!(error instanceof SessionInUseError)) throw error;
        this.cwd = cwd;
        this.state = {...initialState(), sessionId:snapshot.id, sessionNumber:snapshot.sessionNumber, entries:structuredClone(snapshot.entries), configs:snapshot.configs, modes:snapshot.modes,
          contextComplete:snapshot.contextComplete, readOnly:true, connectionAttempted:true, error:error.message};
        this.emit(); return;
      }
    }
    const generation = this.generation;
    this.cwd = cwd;
    this.checkpoints = snapshot?.checkpoints || []; this.contextWindow=snapshot?.contextWindow;
    this.state = { ...initialState(), status: 'connecting', connectionAttempted: true, attachments };
    this.replay = !!snapshot;
    this.emit();
    const pending: acp.SessionNotification[] = [];
    let recoveryLease: string | undefined;
    try {
      const agent = this.createAgent(cwd, pending);
      this.agent = agent;this.activeCacheable=true;
      const info = await agent.initialize();
      if (snapshot && !snapshot.contextPending && this.harness !== 'pi' && !info.agentCapabilities?.loadSession) {
        this.disconnect(); this.releaseLease();
        this.state = {...initialState(),harness:this.harness,sessionId:snapshot.id,sessionNumber:snapshot.sessionNumber,entries:structuredClone(snapshot.entries),
          configs:snapshot.configs,modes:snapshot.modes,contextComplete:snapshot.contextComplete,readOnly:true,connectionAttempted:true,
          error:'当前 ACP 适配器未声明 session/load 能力，仅查看本地记录。需要继续时请显式新建会话；不会自动重放历史。'};
        this.emit(); return;
      }
      const session = await agent.createSession(snapshot?.contextPending ? undefined : snapshot?.id,
        !!snapshot && this.harness !== 'pi' && snapshot.contextComplete === true && snapshot.entries.length === 0);
      const recoveredEmpty = !!snapshot && !snapshot.contextPending && session.sessionId !== snapshot.id;
      if (this.sharedHistory && this.activeLease !== session.sessionId) {
        await this.persistence.pending.catch(() => {});
        await this.sharedHistory.claim(session.sessionId);
        if (this.activeLease) {
          if (recoveredEmpty) recoveryLease = this.activeLease;
          else await this.sharedHistory.release(this.activeLease);
        }
        this.activeLease = session.sessionId;
      }
      if (snapshot && (snapshot.contextPending || recoveredEmpty)) await restoreSettings(agent, session, snapshot);
      else if (!snapshot) this.state.error = await applyPreferences(agent, session, preferences);
      if (recoveredEmpty) this.state.error = '原空会话尚未落盘，已重新建立空连接并保留会话编号；未发送任何消息。';
      if(this.harness==='codex')for(const [id,value] of Object.entries(codexFixedConfigs)){
        const option=session.configOptions?.find(c=>c.id===id);
        if(option?.type==='select'&&option.currentValue!==value){
          const changed=await agent.withTimeout(agent.request('session/set_config_option',{sessionId:session.sessionId,configId:id,value}));
          session.configOptions=changed.configOptions;
        }
      }
      if (generation !== this.generation) return;
      this.conversationId=snapshot?.conversationId||snapshot?.id||session.sessionId;
      this.state.sessionId = session.sessionId; this.state.sessionNumber = snapshot?.sessionNumber; this.state.agent = info.agentInfo?.title || info.agentInfo?.name || 'ACP Agent';
      this.state.modes = session.modes || snapshot?.modes; this.state.configs = session.configOptions || snapshot?.configs;
      this.state.nativeForks = snapshot?.nativeForks;
      for (const notification of pending) if (notification.sessionId === session.sessionId) applyUpdate(this.state, notification.update, this.replay);
      if (snapshot && (snapshot.contextComplete || !this.state.entries.length)) this.state.entries = structuredClone(snapshot.entries);
      this.state.contextComplete = snapshot ? snapshot.contextComplete === true : true;
      this.state.contextPending = snapshot?.contextPending || false;
      if (snapshot && (snapshot.contextPending || recoveredEmpty)) {
        this.state.usage = undefined;
        this.history = this.history.filter(s => s.id !== snapshot.id);
        this.forgottenSessions.add(snapshot.id);
      }
      this.state.status = 'ready'; this.replay = false; await this.rememberActive(); await this.refreshTelemetry(); await this.save();
      if (snapshot && (snapshot.contextPending || recoveredEmpty)) {
        await this.persistence.enqueue(() => this.snapshots.remove(snapshot!.id));
        this.history = this.history.filter(item => item.id !== snapshot.id);
      }
      this.emit();
    } catch (error) {
      this.disconnect(); this.state.status = 'disconnected';
      if (snapshot && this.harness !== 'pi') { this.releaseLease(); this.state.readOnly = true; }
      if (snapshot) { this.state.configs=snapshot.configs;this.state.modes=snapshot.modes; this.state.entries = snapshot.entries; this.state.sessionId = snapshot.id; this.state.sessionNumber = snapshot.sessionNumber; this.state.contextComplete = snapshot.contextComplete; this.state.contextPending = snapshot.contextPending; }
      throw error;
    } finally {
      if (recoveryLease) await this.sharedHistory!.release(recoveryLease);
    }
  }
  private createAgent(cwd: string, pending: acp.SessionNotification[]) {
    const {command,args,env,bundled,setting} = launchSettings(this.config,this.harness);
    const agent = new AgentProcess({
      cwd, harness:this.harness, commandSetting:setting, command:bundled ? process.execPath : command, args:bundled ? [path.join(this.context.extensionUri.fsPath,'dist','pi-adapter.mjs')] : args, env:{...env,...(bundled ? {ELECTRON_RUN_AS_NODE:'1'} : {})},
      log: text => this.log.append(text),
      update: notification => {
        const cachedId=this.sessions.find(agent);
        if(cachedId){const cached=this.sessions.get(cachedId)!;if(notification.sessionId===cachedId)applyUpdate(cached.state,notification.update,false);return;}
        if (this.agent !== agent || !this.state.sessionId) { if(!agent.isClosed)pending.push(notification); return; }
        if (notification.sessionId === this.state.sessionId) { applyUpdate(this.state, notification.update, this.replay); this.emit(); }
      },
      permission: request => {
        if (this.agent !== agent || this.stopping || request.sessionId !== this.state.sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        const id = nextId();
        return new Promise(resolve => { this.permissionResolvers.set(id, resolve); this.state.permissions.push({ id, request }); this.emit(); });
      },
      closed: error => {
        const cachedId=this.sessions.find(agent);if(cachedId){this.sessions.remove(cachedId);return;}
        if (this.agent !== agent) return;
        this.cancelPermissions(); this.state.status = 'disconnected'; this.state.error = error; this.agent = undefined;
        void this.save().catch(error => { this.state.error = String(error); this.emit(); }); this.emit();
      },
    });
    return agent;
  }
  private workbenchCapable(agent=this.agent) {
    const meta=agent?.info?.agentCapabilities?._meta?.['pi-workbench'] as {version?:number}|undefined;
    return agent?.harness === 'pi' && meta?.version===1;
  }
  private async recordUsage(records: UsageRecord[]) {
    const titles = {...this.statistics.titles};
    const merged = mergeUsage(this.statistics.records,records.map(r=>({...r,sessionId:this.conversationId||r.sessionId})));
    const first=this.state.entries.find(e=>e.role==='user');
    if(this.state.sessionId) {
      const id = this.conversationId || this.state.sessionId;
      if(this.config.get('persistHistory',true) && !this.forgottenSessions.has(this.state.sessionId) && first?.role==='user') titles[id] = first.text.slice(0,70);
      else delete titles[id];
    }
    this.statistics = {...this.statistics, records:merged, titles};
    await this.persistence.enqueue(async () => {
      await this.context.workspaceState.update('usageRecords',this.statistics.records);
      await this.context.workspaceState.update('usageTitles',this.statistics.titles);
    });
  }
  private async refreshTelemetry(settledTurn=false) {
    if(this.inspecting)return this.inspecting;
    const agent=this.agent, sessionId=this.state.sessionId;
    this.statistics = {...this.statistics, available:this.workbenchCapable(agent),
      note:this.harness !== 'pi' ? HARNESSES[this.harness].note : this.statistics.note};
    if(!agent || !sessionId || !this.statistics.available || this.state.status==='busy' && !settledTurn)return;
    const entries=this.state.entries.slice();
    const unchanged = () => entries.length === this.state.entries.length && entries.every((entry,i) => entry === this.state.entries[i]);
    this.inspecting=(async()=>{
      try {
        let cursor:number|undefined;
        const records: UsageRecord[] = [];
        do {
          const data=await metadataDeadline(agent.request<Inspection>('_pi_workbench/inspect',{sessionId,cursor}));
          if(this.agent!==agent||this.state.sessionId!==sessionId)return;
          records.push(...data.records || []);
          if(!cursor) {
            if(unchanged())this.state.nativeForks=bindNativeForks(entries,data.forkPoints||[],this.state.nativeForks);
            if(data.contextWindow && Number.isFinite(data.contextWindow) && data.contextWindow>0)this.contextWindow=data.contextWindow;
            for(const [key,value] of Object.entries(data.prices||{}))if(validPrice(value)&&!priceFor(key,presetPrices)&&!['__proto__','constructor','prototype'].includes(key))this.modelPrices[key]=value;
            this.statistics={...this.statistics,prices:{...presetPrices,...this.modelPrices,...this.priceOverrides}};
            // Capture the effective native context only at a stable transcript boundary.
            if(!this.state.contextPending && (this.state.status!=='busy'||settledTurn) && data.context && data.checkpointId && this.state.contextComplete && unchanged() && !this.checkpoints.some(cp=>cp.id===data.checkpointId)) {
              this.checkpoints.push(checkpoint(entries,data.context,'pi',data.checkpointId));this.checkpoints=this.checkpoints.slice(-24);
            }
          }
          if(data.cursor!==undefined && (!Number.isSafeInteger(data.cursor)||data.cursor<=(cursor||0)))throw new Error('Invalid usage pagination');
          cursor=data.cursor;
        } while(cursor!==undefined);
        await this.recordUsage(records);
        this.statistics={...this.statistics,note:undefined};
      } catch(error) {this.statistics={...this.statistics,note:`用量读取未完成：${error instanceof Error?error.message:String(error)}`};}
      finally {this.emit();}
    })();
    try{await this.inspecting;}finally{this.inspecting=undefined;}
  }
  private async prepareEditedContext(entries:Entry[],signal:AbortSignal) {
    const agent=this.agent, sessionId=this.state.sessionId;
    const summarize=this.workbenchCapable(agent)&&agent&&sessionId ? async(text:string,limit:number)=>{
      const result=await agent.request<{text:string;records:UsageRecord[]}>('_pi_workbench/summarize',{sessionId,text,limit});
      await this.recordUsage(result.records||[]);return result.text;
    }:undefined;
    return prepareContext(entries,this.state.contextComplete,this.checkpoints,contextBudget(this.contextWindow),summarize,(done,total)=>{
      this.state.contextOperation={kind:'summary',done,total};this.emit();
    },signal);
  }
  private async branchNative(message: Extract<UiMessage, { type: 'branchMessage' }>) {
    if (this.state.preview || this.state.readOnly || !this.state.sessionId || message.sessionId !== this.state.sessionId) return;
    if (this.harness !== 'pi') throw new Error('此 harness 暂不支持原生分支。');
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    const source=this.agent;
    if(!source || !(source.info?.agentCapabilities?._meta?.['pi-workbench'] as {nativeFork?:boolean})?.nativeFork)throw new Error('当前适配器不支持原生分支，请使用新版内置 Pi 适配器。不会退回摘要重建。');
    if(this.state.contextPending)throw new Error('这是旧版尚未同步的重建会话，没有对应的原生历史位置。');
    const index=this.state.entries.findIndex(e=>e.id===message.id);
    if(index<0||!['user','assistant'].includes(this.state.entries[index].role))return;
    const previous = this.state, oldId = previous.sessionId!, generation = this.generation;
    this.transitioning = true;
    this.state = {...previous, status:'connecting', contextOperation:{kind:'fork'}};
    this.emit();
    this.contextAbort = new AbortController();
    const signal = this.contextAbort.signal;
    const cancel=()=>{void source.request('_pi_workbench/cancel_fork',{sessionId:oldId}).catch(()=>{});};
    signal.addEventListener('abort',cancel,{once:true});
    const pending:acp.SessionNotification[]=[];
    let candidate:AgentProcess|undefined,candidateLease:string|undefined,session:acp.NewSessionResponse;
    try {
      await this.refreshTelemetry();
      const point=this.state.nativeForks?.[message.id];
      if(!point)throw new Error('无法唯一定位此消息的安全原生节点（可能是旧记录、工具中间步骤或重复文本）。不会猜测位置或重新生成摘要。');
      previous.nativeForks=this.state.nativeForks;
      await this.save();signal.throwIfAborted();
      const fork=await source.request<{sessionId:string}>('_pi_workbench/fork',{sessionId:oldId,...point});
      signal.throwIfAborted();
      if(!fork.sessionId||fork.sessionId===oldId)throw new Error('Pi 未返回独立的原生分支。');
      candidate=this.createAgent(this.cwd,pending);const info=await candidate.initialize();
      if(!(info.agentCapabilities?._meta?.['pi-workbench'] as {nativeFork?:boolean})?.nativeFork)throw new Error('目标适配器不支持原生分支，原会话未修改。');
      session=await candidate.createSession(fork.sessionId);
      // The native history determines model/thinking and compaction state at this point.
      // Do not restore the source's CURRENT settings or replay a textual history seed.
      if(candidate.isClosed||generation!==this.generation)throw new Error('连接状态已改变，未切换到分支。');
      if(this.sharedHistory){await this.sharedHistory.claim(session.sessionId);candidateLease=session.sessionId;}
      signal.throwIfAborted();
    } catch(error) {
      candidate?.dispose();
      try {
        if (candidateLease) await this.sharedHistory?.release(candidateLease);
      } finally {
        // Restore transcript/settings, but never roll back a connection or lease loss.
        this.state = {
          ...previous,
          status: this.agent === source && !source.isClosed ? 'ready' : 'disconnected',
          readOnly: previous.readOnly || this.state.readOnly,
          permissions: [],
        };
        this.transitioning = false;
        this.emit();
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.contextAbort = undefined;
      this.state.contextOperation = undefined;
    }
    this.parkActive(previous);this.agent=candidate;this.activeCacheable=true;this.replay=false;
    if(this.sharedHistory)this.activeLease=session.sessionId;
    this.conversationId=session.sessionId;this.checkpoints=[];
    this.state={...initialState(),harness:'pi',status:'ready',connectionAttempted:true,sessionId:session.sessionId,
      agent:previous.agent,attachments:previous.attachments,entries:structuredClone(previous.entries.slice(0,index+1)),nativeForks:previous.nativeForks,
      contextComplete:previous.contextComplete,contextPending:false,configs:session.configOptions||undefined,modes:session.modes||undefined};
    for(const n of pending)if(n.sessionId===session.sessionId&&['available_commands_update','current_mode_update','config_option_update'].includes(n.update.sessionUpdate))applyUpdate(this.state,n.update);
    try {await this.rememberActive();await this.refreshTelemetry();await this.save();}
    finally {this.transitioning=false;this.emit();}
  }
  private cancelPermissions() {
    for (const resolve of this.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.permissionResolvers.clear(); this.state.permissions = [];
  }
  private cacheBytes(value:CachedConversation){return byteSize(JSON.stringify({entries:value.state.entries,attachments:value.state.attachments,checkpoints:value.checkpoints}));}
  private parkActive(state=this.state){
    if(!this.sharedHistory&&this.agent&&!this.agent.isClosed&&state.status==='ready'&&state.sessionId&&!state.preview&&this.activeCacheable&&this.config.get('persistHistory',true)&&!this.forgottenSessions.has(state.sessionId)){
      const cached:CachedConversation={agent:this.agent,state:{...state,statistics:undefined,history:[]},cwd:this.cwd,checkpoints:this.checkpoints,contextWindow:this.contextWindow,conversationId:this.conversationId};
      this.agent=undefined;this.generation++;this.sessions.put(state.sessionId,cached,this.cacheBytes(cached));
    }else { this.disconnect(); this.releaseLease(); }
  }
  private disconnect() {
    this.generation++; this.contextAbort?.abort(); this.cancelPermissions();
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.stopping = false; this.prompting = false; this.agent?.dispose(); this.agent = undefined;
  }
  async attach() {
    try {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区。');
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') throw new Error('请先打开需要添加的代码文件。');
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const limit = this.config.get('maxContextChars', 60000);
      if (text.length > limit) throw new Error(`上下文超过 ${limit} 字符，请选择更小的代码片段。`);
      if (this.state.attachments.length >= 8) throw new Error('每条消息最多附加 8 个代码片段。');
      const name = path.basename(editor.document.fileName) + (selection.isEmpty ? '' : `:${selection.start.line + 1}-${selection.end.line + 1}`);
      this.state.attachments = [...this.state.attachments, { id: nextId(), name, uri: editor.document.uri.toString(), text }];
      await vscode.commands.executeCommand('piAcp.chat.focus'); this.emit();
    } catch (error) { this.state.error = String(error); this.emit(); }
  }
  async perform(message: UiMessage) {
    try {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      await this.historyReady;
      if (this.disposed) return;
      if (message.type === 'deleteMessage') throw new Error('逐条消息删除功能已移除；可从原生历史节点创建分支。');
      if (message.type === 'switchHarness') {
        if (!isHarnessId(message.harness)) throw new Error('未知 harness。');
        if (this.transitioning || this.state.status === 'busy' || this.state.status === 'connecting') { this.emit(); return; }
        if (message.harness === this.harness) { this.emit(); return; }
        this.transitioning = true; this.state.status = 'connecting'; this.emit();
        try { await this.selectHarness(message.harness); } finally {
          if (this.state.status === 'connecting') this.state.status = this.agent ? 'ready' : 'disconnected';
          this.transitioning = false; this.emit();
        }
        return;
      }
      if (message.type === 'refreshHistory') { await this.refreshSharedHistory(); this.emit(); return; }
      if (message.type === 'releaseSession') {
        if (this.transitioning || this.state.status === 'busy' || this.state.status === 'connecting') return;
        this.transitioning = true;
        try { await this.save(); this.disconnect(); this.releaseLease(); await this.persistence.pending; this.state.status = 'disconnected'; this.state.readOnly = true; }
        finally { this.transitioning = false; this.emit(); }
        return;
      }
      if (message.type === 'ready') {
        this.stateEncoder.reset();
        // Webview reloads must not reset a session or repeatedly retry a failed start.
        if (!this.autoConnectHandled) {
          this.autoConnectHandled = true;
          if (this.state.status === 'disconnected' && !this.state.preview) await this.perform({ type: 'connect' });
        }
        this.emit(); return;
      }
      if (message.type === 'dismissError') {
        // A click on an older banner must not dismiss a newer error in flight.
        if (this.state.error === message.error) this.state.error = undefined;
        this.emit(); return;
      }
      if (message.type === 'deleteHistory' || message.type === 'clearHistory') {
        if (this.sharedHistory && await vscode.window.showWarningMessage(message.type === 'clearHistory' ? '清空此服务器账户的全部共享会话？所有客户端都会失去这些历史记录。' : '删除此共享会话？所有客户端都会失去这条历史记录。', {modal:true}, '删除') !== '删除') return;
        if (message.type === 'deleteHistory') {
          const forgotten = this.history.find(item => item.id === message.id);
          if (!forgotten) return;
          const titles = {...this.statistics.titles};
          delete titles[forgotten.conversationId || forgotten.id];
          this.statistics = {...this.statistics, titles};
          this.forgottenSessions.add(message.id);this.sessions.remove(message.id);
          this.history = this.history.filter(item => item.id !== message.id);
        } else {
          this.history.forEach(item => this.forgottenSessions.add(item.id));
          if (this.state.sessionId) this.forgottenSessions.add(this.state.sessionId);
          this.history = []; this.sessions.clear(); this.statistics = {...this.statistics, titles:{}};
        }
        // Forget the local record without interrupting an active agent turn.
        await this.persistence.enqueue(async () => {
          if (message.type === 'deleteHistory') await this.snapshots.remove(message.id);
          else await this.snapshots.clear();
          if (!this.sharedHistory) await this.context.workspaceState.update('history', this.history.length ? this.history : undefined);
          await this.context.workspaceState.update('usageTitles', this.statistics.titles);
          for (const harness of HARNESS_IDS) {
            const key = harnessKey('activeSession',harness), active = this.context.workspaceState.get<string | null>(key);
            if (message.type === 'clearHistory' || message.type === 'deleteHistory' && active === message.id) await this.context.workspaceState.update(key, null);
            if (message.type === 'clearHistory' || message.type === 'deleteHistory' && this.transientSnapshots.get(harness)?.id === message.id) this.transientSnapshots.delete(harness);
          }
        });
        this.emit(); return;
      }
      if(message.type==='copyConversation'){await vscode.env.clipboard.writeText(this.conversationText());return;}
      if(message.type==='cancelContext'){this.contextAbort?.abort(new Error('已取消操作，原会话保留。'));if(this.state.contextOperation?.kind==='summary'&&this.workbenchCapable()&&this.agent&&this.state.sessionId)void this.agent.request('_pi_workbench/cancel_summary',{sessionId:this.state.sessionId}).catch(()=>{});return;}
      if(message.type==='refreshStatistics'){await this.refreshTelemetry();this.emit();return;}
      if(message.type==='setPrice'){
        if(typeof message.model!=='string'||!message.model.trim()||message.model.length>300||['__proto__','constructor','prototype'].includes(message.model))throw new Error('模型标识无效。');
        if(message.price===undefined)delete this.priceOverrides[message.model];
        else {if(!validPrice(message.price))throw new Error('价格必须为非负有限数值。');this.priceOverrides[message.model]={input:message.price.input,output:message.price.output,cacheRead:message.price.cacheRead,cacheWrite:message.price.cacheWrite,source:'用户设置'};}
        this.statistics={...this.statistics,prices:{...presetPrices,...this.modelPrices,...this.priceOverrides}};await this.context.workspaceState.update('prices',this.priceOverrides);this.emit();return;
      }
      if (message.type === 'logs') { this.log.show(); return; }
      if (message.type === 'login') {
        const cwd = await this.workspaceCwd();
        const {command,args,env,bundled} = launchSettings(this.config,this.harness);
        const shellPath = this.harness==='codex' ? this.config.get('codex.loginCommand','codex') : bundled ? (env.PI_ACP_PI_COMMAND||process.env.PI_ACP_PI_COMMAND||'pi') : command;
        const shellArgs = this.harness==='codex' ? ['login'] : this.harness==='claude' ? [...args,'--cli','/login'] : bundled ? [] : [...args,'--terminal-login'];
        vscode.window.createTerminal({ name:`${HARNESSES[this.harness].name} Login`,cwd,shellPath,shellArgs,env }).show();return;
      }
      if (message.type === 'cancel') {
        if (!this.agent || this.state.status !== 'busy' || !this.state.sessionId) return;
        this.stopping = true; this.cancelPermissions(); this.emit();
        if (!this.prompting) return;
        await this.agent.cancel(this.state.sessionId);
        if (this.cancelTimer) clearTimeout(this.cancelTimer);
        if (this.state.status !== 'busy') return;
        this.cancelTimer = setTimeout(() => {
          this.disconnect(); this.state.status = 'disconnected'; this.state.error = 'Agent 未在 5 秒内响应取消，连接已关闭。可从历史记录恢复。'; void this.save().catch(error => { this.state.error = String(error); this.emit(); }); this.emit();
        }, 5000); return;
      }
      if (message.type === 'permission') {
        const item = this.state.permissions.find(p => p.id === message.id);
        if (!item) return;
        if (message.optionId && !item.request.options.some(o => o.optionId === message.optionId)) return;
        this.permissionResolvers.get(message.id)?.({ outcome: message.optionId ? { outcome: 'selected', optionId: message.optionId } : { outcome: 'cancelled' } });
        this.permissionResolvers.delete(message.id); this.state.permissions = this.state.permissions.filter(p => p.id !== message.id); this.emit(); return;
      }
      if(message.type==='attachmentError'){if((message.harness===undefined||message.harness===this.harness)&&message.sessionId===this.state.sessionId){this.state.error=String(message.error).slice(0,300);this.emit();}return;}
      if(message.type==='attachImages'){
        if(message.harness!==undefined&&message.harness!==this.harness)throw new Error('Harness 已切换，请重新粘贴图片。');
        if(message.sessionId!==this.state.sessionId)throw new Error('会话已切换，请重新粘贴图片。');
        if(!Array.isArray(message.images)||!message.images.length||message.images.length+this.state.attachments.length>8)throw new Error('每条消息最多附加 8 个附件。');
        const total=message.images.reduce((n,image)=>n+validateImage(image),0)+this.state.attachments.reduce((n,a)=>n+(a.kind==='image'?Buffer.byteLength(a.data,'base64'):0),0);
        if(total>MAX_ATTACHMENT_IMAGE_BYTES)throw new Error('每条消息的图片总大小不能超过 6 MB。');
        this.state.attachments=[...this.state.attachments,...message.images.map(image=>({kind:'image' as const,id:nextId(),name:image.name.slice(0,120)||'粘贴图片',mimeType:image.mimeType,data:image.data}))];this.emit();return;
      }
      if (message.type === 'attach') { await this.attach(); return; }
      if (message.type === 'removeAttachment') { this.state.attachments = this.state.attachments.filter(a => a.id !== message.id); this.emit(); return; }
      if (message.type === 'open') { await this.openLink(message.url, message.line); return; }
      if (message.type === 'diff') { await this.openDiff(message.id, message.index); return; }
      if (message.type === 'export') { await this.exportChat(); return; }
      if (this.transitioning || this.state.status === 'busy' || this.state.status === 'connecting') return;
      this.state.error = undefined;
      if (message.type === 'new') await this.start('new');
      else if (message.type === 'connect') {
        const snapshot = this.currentSnapshot();
        if (snapshot) await this.start(snapshot);
      }
      else if (message.type === 'branchMessage') await this.branchNative(message);
      else if (message.type === 'resume') {
        const snapshot = this.history.find(s => s.id === message.id);
        if (snapshot) await this.start(snapshot);
      } else if (message.type === 'preview') {
        this.transitioning = true;
        try {
          await this.save(); this.disconnect(); this.releaseLease(); this.state = { ...initialState(), preview: true, entries: [{ id: nextId(), role: 'assistant', text: demoMarkdown }] };
          await vscode.commands.executeCommand('piAcp.chat.focus');
        } finally { this.transitioning = false; }
      } else if (message.type === 'send') {
        if (typeof message.text !== 'string' || !message.text.trim()&&!this.state.attachments.some(a=>a.kind==='image')) return;
        if (message.text.length > 500000) throw new Error('消息过长。');
        if (!this.agent || !this.state.sessionId || this.state.status !== 'ready') throw new Error('请先连接 Agent 或从历史记录恢复会话。');
        if (this.state.contextPending && message.text.trimStart().startsWith('/')) throw new Error('请先发送普通消息同步修改后的上下文，再使用 /compact 等命令。');
        if(this.state.attachments.some(a=>a.kind==='image')&&!this.agent.info?.agentCapabilities?.promptCapabilities?.image)throw new Error('当前 Agent 未声明图片支持，请切换支持图片的 Agent。');
        const agent = this.agent, generation = this.generation;
        let seed:acp.ContentBlock|undefined;
        if(this.state.contextPending){
          // Include unsynchronized messages left by a cancelled/failed send as well.
          this.transitioning=true;this.state.status='connecting';this.contextAbort=new AbortController();this.emit();
          try {const prepared=await this.prepareEditedContext(this.state.entries,this.contextAbort.signal);
            this.checkpoints=[...this.checkpoints,prepared.checkpoint].slice(-24);
            seed={type:'text',text:prepared.text+'\n\n当前请求：\n'};
          } finally {this.contextAbort=undefined;this.state.contextOperation=undefined;this.state.status=this.agent?'ready':'disconnected';this.transitioning=false;this.emit();}
        }
        if(generation!==this.generation || agent!==this.agent)throw new Error('连接状态已改变，请重试。');
        const prompt: acp.ContentBlock[] = message.text.trim()?[{ type: 'text', text: message.text }]:[];
        const attached = this.state.attachments;
        for (const a of attached) {
          if(a.kind==='image'){prompt.push({type:'image',data:a.data,mimeType:a.mimeType});continue;}
          if (agent.info?.agentCapabilities?.promptCapabilities?.embeddedContext) prompt.push({ type: 'resource', resource: { uri: a.uri, mimeType: 'text/plain', text: a.text } });
          else prompt.push({ type: 'text', text: `\n附加代码上下文：${a.name} (${a.uri})\n${a.text}` });
        }
        const contextBlocks = structuredClone(prompt);
        if (seed) prompt.unshift(seed);
        checkPromptSize(prompt);
        if(seed && byteSize(JSON.stringify(prompt.filter(b=>b.type!=='image')))>contextBudget(this.contextWindow)*2)throw new Error('本次输入连同重建上下文超过安全预算，请缩小当前消息或附件后重试。');
        this.state.entries.push({ id: nextId(), role: 'user', contextBlocks, text: message.text + (attached.length ? '\n\n' + attached.map(a => `📎 ${a.name}`).join(' · ') : '') });
        this.state.attachments = []; this.state.status = 'busy'; this.stopping = false; this.emit();
        try {
          await this.save();
          await this.view?.webview.postMessage({ type: 'sent' });
          if (this.stopping || generation !== this.generation) {
            if (generation === this.generation) this.state.entries.push({ id: nextId(), role: 'notice', text: '本轮已停止，消息尚未发送给 Agent。' });
            return;
          }
          this.prompting = true;
          const response = await agent.prompt(this.state.sessionId, prompt);
          if (generation === this.generation) this.state.contextPending = !!seed && response.stopReason === 'cancelled';
          if (generation === this.generation && response.stopReason !== 'end_turn') this.state.entries.push({ id: nextId(), role: 'notice', text: `本轮结束：${response.stopReason}` });
          if (seed && response.stopReason === 'cancelled' && generation === this.generation) {
            // Cancellation does not prove that the peer retained the historical seed.
            this.disconnect(); this.state.status = 'disconnected'; await this.save(); this.emit();
          }
        } catch (error) {
          if (seed && generation === this.generation) {
            // The peer may have accepted some of the seed before failing. Never resend into it.
            this.disconnect(); this.state.status = 'disconnected'; this.state.contextPending = true;
            await this.save(); this.emit();
          }
          throw error;
        } finally {
          if (generation === this.generation) {
            if (this.cancelTimer) clearTimeout(this.cancelTimer);
            this.stopping = false; this.prompting = false; this.cancelPermissions();
            try {
              await this.refreshTelemetry(true);
              if(this.agent) await this.rememberSettings();
            } finally {
              this.state.status = this.agent ? 'ready' : 'disconnected';
              try { await this.save(); } finally { this.emit(); }
            }
          }
        }
      } else if (message.type === 'mode' && this.agent && this.state.sessionId) {
        if (!this.state.modes?.availableModes.some(m => m.id === message.value)) return;
        this.state.status = 'connecting'; this.emit();
        try {
          await this.agent.withTimeout(this.agent.request('session/set_mode', { sessionId: this.state.sessionId, modeId: message.value }), 15000);
          this.state.modes.currentModeId = message.value;
          await this.rememberSettings(); await this.save();
        } finally { this.state.status = this.agent ? 'ready' : 'disconnected'; }
      } else if (message.type === 'config' && this.agent && this.state.sessionId) {
        if(this.harness==='codex'&&Object.hasOwn(codexFixedConfigs,message.id))throw new Error('此选项已隐藏并使用默认值：Fast mode Off、协作模式 Default。');
        const config = this.state.configs?.find(c => c.id === message.id);
        if (!config || config.type !== 'select') return;
        const options = config.options.flatMap(o => 'options' in o ? o.options : [o]);
        if (!options.some(o => o.value === message.value)) return;
        this.state.status = 'connecting'; this.emit();
        try {
          const response = await this.agent.withTimeout(this.agent.request('session/set_config_option', { sessionId: this.state.sessionId, configId: message.id, value: message.value }), 15000);
          this.state.configs = response.configOptions;
          await this.rememberSettings(); await this.save();
          await this.refreshTelemetry();
        } finally { this.state.status = this.agent ? 'ready' : 'disconnected'; }
      }
      this.emit();
    } catch (error) { const detail = error instanceof Error ? error.message : String(error);
      this.state.error = detail === 'ACP connection closed' && this.state.error ? this.state.error : detail; this.log.appendLine(this.state.error); this.emit(); }
  }
  private async openLink(url: string, line?: number) {
    if (typeof url !== 'string' || url.length > 10000) return;
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) { await vscode.env.openExternal(vscode.Uri.parse(url)); return; }
    if (!this.cwd || /^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('file:')) return;
    const target = url.startsWith('file:') ? vscode.Uri.parse(url).fsPath : path.resolve(this.cwd, url.split('#')[0]);
    const [root, actual] = await Promise.all([realpath(this.cwd), realpath(target)]);
    const relative = path.relative(root, actual);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('只能从聊天打开当前会话工作区内的文件。');
    const row = typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line - 1 : undefined;
    await vscode.window.showTextDocument(vscode.Uri.file(actual), { preview: true, selection: row === undefined ? undefined : new vscode.Range(row, 0, row, 0) });
  }
  private async openDiff(id: string, index: number) {
    const item = this.state.entries.find(e => e.id === id);
    if (item?.role !== 'tool' || !Number.isInteger(index)) return;
    const content = item.tool.content?.[index];
    if (content?.type !== 'diff') return;
    const key = encodeURIComponent(`${this.state.sessionId || 'preview'}-${id}-${index}`);
    const left = vscode.Uri.from({ scheme: 'pi-acp-diff', path: `/${key}/before/${path.basename(content.path)}` });
    const right = vscode.Uri.from({ scheme: 'pi-acp-diff', path: `/${key}/after/${path.basename(content.path)}` });
    this.diffDocs.delete(left.toString()); this.diffDocs.delete(right.toString());
    this.diffDocs.set(left.toString(), content.oldText || ''); this.diffDocs.set(right.toString(), content.newText);
    while (this.diffDocs.size > 40 || [...this.diffDocs.values()].reduce((n, text) => n + byteSize(text), 0) > 16 * 1024 * 1024 && this.diffDocs.size > 2) {
      this.diffDocs.delete(this.diffDocs.keys().next().value!);
      this.diffDocs.delete(this.diffDocs.keys().next().value!);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(content.path)} · Agent 修改`, { preview: true });
  }
  private conversationText() {return this.state.entries.map(e => e.role === 'tool' ? `### 工具：${e.tool.title}\n\n${JSON.stringify(e.tool,null,2)}` : `## ${e.role}\n\n${e.text}`).join('\n\n---\n\n');}
  private async exportChat() {
    const uri = await vscode.window.showSaveDialog({ defaultUri: this.cwd ? vscode.Uri.file(path.join(this.cwd, 'pi-conversation.md')) : undefined, filters: { Markdown: ['md'] } });
    if (!uri) return;
    const text = this.conversationText();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  }
  dispose() {
    if (this.disposed) return;
    void this.save().catch(() => {}); this.disconnect();this.releaseLease();this.sessions.clear();
    this.disposed = true;
    if (this.historyPoll) clearInterval(this.historyPoll);
    if (this.timer) clearTimeout(this.timer);
    this.resources.forEach(r => r.dispose()); this.diffDocs.clear();
  }
}
