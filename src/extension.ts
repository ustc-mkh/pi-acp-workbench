import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { codexFixedConfigs } from './session-settings';
import {SessionPreferences,modelPreferences} from './session-preferences';
import { applyPreferences } from './session-configuration';
import {WorkspaceDiff} from './workspace-diff';
import {DiffDocuments,openWorkspaceLink} from './workspace-documents';
import { SessionCache } from './session-cache';
import { StateEncoder } from './state-channel';
import { validateImage, MAX_ATTACHMENT_IMAGE_BYTES } from './images';
import { AgentProcess, type AgentOptions } from './agent';
import { RemoteAgent, type Agent } from './remote-agent';
import { SessionClient } from './session-wire';
import type { ServiceState } from './session-protocol';
import { applyUpdate, initialState, nextId } from './state';
import { checkPromptSize, byteSize } from './context';
import {ConversationHistory} from './conversation-history';
import {ConversationStatistics} from './conversation-statistics';
import { HARNESSES, HARNESS_IDS, harnessKey, isHarnessId, snapshotHarness, launchSettings, type HarnessId } from './harness';
import { SessionInUseError } from './shared-history';
import type {UsageRecord} from './telemetry';
import { demoMarkdown } from './demo';
import type { Entry, Snapshot, UiMessage } from './shared';

export function activate(context: vscode.ExtensionContext, agentFactory?: (options:AgentOptions)=>Agent) {
  const provider = new ChatProvider(context,agentFactory);
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

interface CachedConversation {agent:Agent;state:ReturnType<typeof initialState>;cwd:string;contextWindow?:number;conversationId?:string}

class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private sessions=new SessionCache<CachedConversation>();
  private activeCacheable=true;
  private view?: vscode.WebviewView;
  private stateEncoder = new StateEncoder();
  private state = initialState();
  private harness: HarnessId = 'pi';
  private harnessAttachments = new Map<HarnessId, ReturnType<typeof initialState>['attachments']>();
  private transientSnapshots = new Map<HarnessId, Snapshot>();
  private agent?: Agent;
  private cwd = '';
  private replay = false;
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private cancelTimer?: NodeJS.Timeout;
  private stopping = false;
  private prompting = false;
  private transitioning = false;
  private autoConnectHandled = false;
  private historyStore: ConversationHistory;
  private get history(){return this.historyStore.items;}
  private set history(items:Snapshot[]){this.historyStore.items=items;}
  private get snapshots(){return this.historyStore.snapshots;}
  private get sharedHistory(){return this.historyStore.shared;}
  private get historyReady(){return this.historyStore.ready;}
  private get activeLease(){return this.historyStore.activeLease;}
  private set activeLease(id:string|undefined){this.historyStore.activeLease=id;}
  private get persistence(){return this.historyStore.persistence;}
  private get forgottenSessions(){return this.historyStore.forgotten;}
  private disposed = false;
  private contextWindow?: number;
  private conversationId?: string;
  private contextAbort?: AbortController;
  private telemetry: ConversationStatistics;
  private get statistics(){return this.telemetry.value;}
  private get inspecting(){return this.telemetry.pending;}
  private permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();
  private preferences = new SessionPreferences();
  private documents = new DiffDocuments();
  private resources: vscode.Disposable[] = [];
  private serviceClient = new SessionClient();
  private applyServiceState(value:ServiceState) {
    if(this.harness!=='pi'||this.state.sessionId!==value.snapshot.id)return;
    const s=value.snapshot;
    this.state.entries=s.entries;this.state.sessionNumber=s.sessionNumber;this.state.configs=s.configs;this.state.modes=s.modes;
    this.state.nativeForks=s.nativeForks;this.state.permissions=value.permissions;this.state.commands=value.commands;
    this.state.contextComplete=s.contextComplete;this.state.status=value.busy?'busy':'ready';this.state.error=value.error;
    if(this.config.get('persistHistory',true)&&!this.forgottenSessions.has(s.id))this.history=[{...s,entries:[],stored:true},...this.history.filter(h=>h.id!==s.id)];this.emit();
  }
  private log = vscode.window.createOutputChannel('Pi Agent');
  constructor(private context: vscode.ExtensionContext,private agentFactory?: (options:AgentOptions)=>Agent) {
    const selected = context.workspaceState.get('selectedHarness','pi');
    if (isHarnessId(selected)) this.harness = selected;
    this.state.harness = this.harness;
    this.serviceClient = new SessionClient(this.config.get<string>('serviceSocket')||undefined);
    this.historyStore=new ConversationHistory({
      storage:context.workspaceState,
      localDirectory:context.storageUri?.fsPath?path.join(context.storageUri.fsPath,'conversations'):undefined,
      sharedDirectory:this.config.get('sharedHistory',true)?path.join(homedir(),'.pi','pi-acp-workbench','history'):undefined,
      enabled:()=>this.config.get('persistHistory',true),current:()=>this.state,changed:()=>this.emit(),
      error:error=>{this.log.appendLine(`[history] ${String(error)}`);this.state.error=String(error);this.emit();},
      leaseLost:()=>{this.disconnect();this.state.status='disconnected';this.state.readOnly=true;this.state.error='共享会话锁已失效，已停止本窗口的 Agent。请重新连接。';this.emit();},
      remote:agentFactory?undefined:{list:()=>this.serviceClient.call<Snapshot[]>('list'),remove:id=>this.serviceClient.call('remove',{sessionId:id},undefined,0)},
    });
    this.telemetry=new ConversationStatistics(context.workspaceState,this.persistence,()=>({agent:this.agent,state:this.state,harness:this.harness,conversationId:this.conversationId,
      retained:this.config.get('persistHistory',true)&&!this.forgottenSessions.has(this.state.sessionId||'')}),value=>{this.contextWindow=value;},()=>this.emit());
    this.historyStore.start();
    if (!this.config.get('persistHistory', true)) this.disableHistory();
    this.resources.push(this.log, this.documents, vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('piAcp')) return;
      if(['codex','claude'].some(key=>e.affectsConfiguration('piAcp.'+key))){this.sessions.clear();this.activeCacheable=false;}
      if (!this.config.get('persistHistory', true)) this.disableHistory();
      else if (this.sharedHistory && e.affectsConfiguration('piAcp.persistHistory')) {
        void this.historyStore.initialize();
      }
      this.emit();
    }));
  }
  private get managedPi(){return this.harness==='pi'&&!this.agentFactory;}
  private get config() { return vscode.workspace.getConfiguration('piAcp'); }
  private disableHistory() {
    this.telemetry.forget();this.sessions.clear();
    void this.historyStore.disable(async()=>{await this.telemetry.persistTitles();}).catch(error=>{this.state.error=String(error);this.emit();});
  }
  private refreshSharedHistory(){return this.historyStore.refresh();}
  private releaseLease(){this.historyStore.releaseLease();}
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
      this.state.history = this.history.map(({ id, cwd, title, updated, sessionNumber, harness }) => ({ id, cwd, title, updated, sessionNumber, harness }));
      this.telemetry.models(this.state);
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
    if(this.managedPi)return; // The session service is the sole Pi history writer.
    const title = this.state.entries.find(e => e.role === 'user');
    const snapshot: Snapshot = {
      id: this.state.sessionId, harness:this.harness, sessionNumber:this.state.sessionNumber, cwd: this.cwd, title: title && title.role === 'user' ? title.text.slice(0, 70) : '新对话',
      updated: Date.now(), entries: structuredClone(this.state.entries), nativeForks:structuredClone(this.state.nativeForks),
      contextComplete: this.state.contextComplete,
      configs: structuredClone(this.state.configs), modes: structuredClone(this.state.modes),
      contextWindow:this.contextWindow,conversationId:this.conversationId,
    };
    await this.historyStore.save(snapshot);
  }

  /** Only an explicit active-session pointer can restore a conversation. */
  private lastSnapshot() {
    const id = this.context.workspaceState.get<string | null>(harnessKey('activeSession',this.harness));
    const local = this.history.filter(s => {
      try { return snapshotHarness(s) === this.harness && vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === s.cwd); }
      catch { return false; }
    });
    return local.find(s => s.id === id);
  }
  private currentSnapshot(): Snapshot | undefined {
    if (!this.state.sessionId || this.state.preview) return this.lastSnapshot() || this.transientSnapshots.get(this.harness);
    return { id:this.state.sessionId, harness:this.harness, sessionNumber:this.state.sessionNumber, cwd:this.cwd, title:'', updated:Date.now(), entries:this.state.entries,
      contextComplete:this.state.contextComplete,  nativeForks:this.state.nativeForks,
      configs:this.state.configs, modes:this.state.modes,
      contextWindow:this.contextWindow, conversationId:this.conversationId };
  }
  private async readSnapshot(snapshot: Snapshot) {
    // Unsaved in-memory context belongs to our leased session, not to a stale disk snapshot.
    if (this.sharedHistory && !snapshot.stored && !this.state.readOnly && snapshot.id === this.state.sessionId) return structuredClone(snapshot);
    const data = snapshot.harness==='pi'&&!this.agentFactory ? (await this.serviceClient.call<ServiceState>('state',{sessionId:snapshot.id})).snapshot : await this.snapshots.read(snapshot);
    if (snapshotHarness(data) !== snapshotHarness(snapshot)) throw new Error('历史记录的 harness 不匹配，未启动 Agent。');
    return {...data,sessionNumber:data.sessionNumber ?? snapshot.sessionNumber};
  }
  private async rememberSettings() {
    if (this.managedPi || this.state.preview || !this.state.sessionId) return;
    await this.preferences.save(this.harness,this.state);
  }
  private async rememberActive() {
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
    this.harness = harness; this.cwd = ''; this.contextWindow = undefined; this.conversationId = undefined;
    this.state = {...initialState(),harness,attachments:this.harnessAttachments.get(harness) || []};
    this.telemetry.reset(harness);
    this.autoConnectHandled = true;
    await this.context.workspaceState.update('selectedHarness',harness);
    const previous = this.lastSnapshot() || this.transientSnapshots.get(harness);
    if (previous) {
      const snapshot = previous.stored ? await this.snapshots.read(previous) : previous;
      this.cwd = snapshot.cwd; this.contextWindow = snapshot.contextWindow; this.conversationId = snapshot.conversationId;
      this.state = {...this.state,sessionId:snapshot.id,sessionNumber:snapshot.sessionNumber,entries:structuredClone(snapshot.entries),configs:snapshot.configs,modes:snapshot.modes,
        contextComplete:snapshot.contextComplete,readOnly:true,connectionAttempted:true};
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
    if(!cached&&snapshot){snapshot=await this.readSnapshot(snapshot);}
    try{await this.save();}catch(error){if(cached)this.sessions.put(snapshot!.id,cached,this.cacheBytes(cached));throw error;}
    if(cached?.agent.isClosed){cached=undefined;snapshot=await this.readSnapshot(snapshot!);}
    const attachments = !this.state.sessionId || snapshot?.id === this.state.sessionId ? this.state.attachments : [];
    const preferences = !snapshot && !this.managedPi ? await this.preferences.read(this.harness) : [];
    this.parkActive();
    if(cached){
      this.agent=cached.agent;this.activeCacheable=true;this.state=cached.state;this.cwd=cached.cwd;this.contextWindow=cached.contextWindow;this.conversationId=cached.conversationId;this.replay=false;
      this.state.status='ready';await this.rememberActive();this.emit();return;
    }
    if (!this.managedPi && this.sharedHistory && snapshot) {
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
    this.contextWindow=snapshot?.contextWindow;
    this.state = { ...initialState(), status: 'connecting', connectionAttempted: true, attachments };
    this.replay = !!snapshot;
    this.emit();
    const pending: acp.SessionNotification[] = [];
    try {
      const agent = this.createAgent(cwd, pending);
      this.agent = agent;this.activeCacheable=true;
      const info = await agent.initialize();
      if (snapshot && this.harness !== 'pi' && !info.agentCapabilities?.loadSession) {
        this.disconnect(); this.releaseLease();
        this.state = {...initialState(),harness:this.harness,sessionId:snapshot.id,sessionNumber:snapshot.sessionNumber,entries:structuredClone(snapshot.entries),
          configs:snapshot.configs,modes:snapshot.modes,contextComplete:snapshot.contextComplete,readOnly:true,connectionAttempted:true,
          error:'当前 ACP 适配器未声明 session/load 能力，仅查看本地记录。需要继续时请显式新建会话；不会自动重放历史。'};
        this.emit(); return;
      }
      const session = await agent.createSession(snapshot?.id);
      if (!this.managedPi && this.sharedHistory && this.activeLease !== session.sessionId) {
        await this.persistence.pending.catch(() => {});
        await this.sharedHistory.claim(session.sessionId);
        if (this.activeLease) await this.sharedHistory.release(this.activeLease);
        this.activeLease = session.sessionId;
      }
      if (!snapshot && !this.managedPi) this.state.error = await applyPreferences(agent, session, preferences);
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
      if (snapshot) this.state.entries = structuredClone(snapshot.entries);
      this.state.contextComplete = true;
      if (!snapshot && !this.state.error) await this.rememberSettings();
      this.state.status = 'ready'; this.replay = false; if(agent instanceof RemoteAgent)await agent.sync(); await this.rememberActive(); await this.refreshTelemetry(); await this.save();
      this.emit();
    } catch (error) {
      this.disconnect(); this.state.status = 'disconnected';
      if (snapshot && this.harness !== 'pi') { this.releaseLease(); this.state.readOnly = true; }
      if (snapshot) { this.state.configs=snapshot.configs;this.state.modes=snapshot.modes; this.state.entries = snapshot.entries; this.state.sessionId = snapshot.id; this.state.sessionNumber = snapshot.sessionNumber; this.state.contextComplete = snapshot.contextComplete; }
      throw error;
    }
  }
  private createAgent(cwd: string, pending: acp.SessionNotification[]) {
    const {command,args,env,setting} = this.harness==='pi' ? {command:'',args:[],env:{},setting:'sessions.json'} : launchSettings(this.config,this.harness);
    const options:AgentOptions = {
      cwd, harness:this.harness, commandSetting:setting, command, args, env,
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
    };
    const agent:Agent = this.agentFactory ? this.agentFactory(options) : this.harness==='pi' ? new RemoteAgent(options,value=>{if(this.agent===agent)this.applyServiceState(value);},this.config.get<string>('serviceSocket')||undefined) : new AgentProcess(options);
    return agent;
  }
  private recordUsage(records:UsageRecord[]){return this.telemetry.record(records);}
  private refreshTelemetry(settledTurn=false){return this.telemetry.refresh(settledTurn);}
  private async branchNative(message: Extract<UiMessage, { type: 'branchMessage' }>) {
    if (this.state.preview || this.state.readOnly || !this.state.sessionId || message.sessionId !== this.state.sessionId) return;
    if (this.harness !== 'pi') throw new Error('此 harness 暂不支持原生分支。');
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    const source=this.agent;
    if(!source || !(source.info?.agentCapabilities?._meta?.['pi-workbench'] as {nativeFork?:boolean})?.nativeFork)throw new Error('当前适配器不支持原生分支，请使用新版内置 Pi 适配器。不会退回摘要重建。');
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
    let candidate:Agent|undefined,candidateLease:string|undefined,session:acp.NewSessionResponse;
    try {
      await this.refreshTelemetry(true);
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

      if(!this.managedPi&&this.sharedHistory){await this.sharedHistory.claim(session.sessionId);candidateLease=session.sessionId;}
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

    if(!this.managedPi&&this.sharedHistory)this.activeLease=session.sessionId;
    this.conversationId=session.sessionId;
    this.state={...initialState(),harness:'pi',status:'ready',connectionAttempted:true,sessionId:session.sessionId,
      agent:previous.agent,attachments:previous.attachments,entries:structuredClone(previous.entries.slice(0,index+1)),nativeForks:previous.nativeForks,
      contextComplete:previous.contextComplete,configs:session.configOptions||undefined,modes:session.modes||undefined};
    for(const n of pending)if(n.sessionId===session.sessionId&&['available_commands_update','current_mode_update','config_option_update'].includes(n.update.sessionUpdate))applyUpdate(this.state,n.update);
    if(candidate instanceof RemoteAgent)await candidate.sync();
    try {await this.rememberActive();await this.refreshTelemetry();await this.save();}
    finally {this.transitioning=false;this.emit();}
  }
  private cancelPermissions() {
    for (const resolve of this.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.permissionResolvers.clear(); this.state.permissions = [];
  }
  private cacheBytes(value:CachedConversation){return byteSize(JSON.stringify({entries:value.state.entries,attachments:value.state.attachments,}));}
  private parkActive(state=this.state){
    if(!this.managedPi&&!this.sharedHistory&&this.agent&&!this.agent.isClosed&&state.status==='ready'&&state.sessionId&&!state.preview&&this.activeCacheable&&this.config.get('persistHistory',true)&&!this.forgottenSessions.has(state.sessionId)){
      const cached:CachedConversation={agent:this.agent,state:{...state,statistics:undefined,history:[]},cwd:this.cwd,contextWindow:this.contextWindow,conversationId:this.conversationId};
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
  async perform(message: UiMessage):Promise<void> {
    try {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      await this.historyReady;
      if (this.disposed) return;
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
          this.telemetry.forget(forgotten.conversationId||forgotten.id);this.sessions.remove(message.id);
        } else {this.sessions.clear();this.telemetry.forget();}
        const deletedState = this.state;
        const deletesCurrent = message.type === 'clearHistory' || message.type === 'deleteHistory' && message.id === deletedState.sessionId;
        await this.historyStore.remove(message.type==='deleteHistory'?message.id:undefined,async()=>{
          await this.telemetry.persistTitles();
          for(const harness of HARNESS_IDS)if(message.type==='clearHistory'||message.type==='deleteHistory'&&this.transientSnapshots.get(harness)?.id===message.id)this.transientSnapshots.delete(harness);
        });
        if (deletesCurrent && this.state === deletedState) {
          this.disconnect(); this.releaseLease();
          this.cwd = ''; this.contextWindow = undefined; this.conversationId = undefined;
          this.state = {...initialState(),harness:this.harness};
          this.telemetry.reset(this.harness);
          this.autoConnectHandled = true;
        }
        this.emit(); return;
      }
      if(message.type==='copyConversation'){await vscode.env.clipboard.writeText(this.conversationText());return;}
      if(message.type==='cancelContext'){this.contextAbort?.abort(new Error('已取消操作，原会话保留。'));return;}
      if(message.type==='refreshStatistics'){await this.refreshTelemetry();this.emit();return;}
      if(message.type==='setPrice'){
        await this.telemetry.setPrice(message.model,message.price);this.emit();return;
      }
      if (message.type === 'logs') { this.log.show(); return; }
      if (message.type === 'login') {
        const cwd = await this.workspaceCwd();
        const {command,args,env} = this.harness==='pi'?{command:process.env.PI_ACP_PI_COMMAND||'pi',args:[],env:{}}:launchSettings(this.config,this.harness);
        const shellPath = this.harness==='codex' ? this.config.get('codex.loginCommand','codex') : command;
        const shellArgs = this.harness==='codex' ? ['login'] : this.harness==='claude' ? [...args,'--cli','/login'] : [];
        vscode.window.createTerminal({ name:`${HARNESSES[this.harness].name} Login`,cwd,shellPath,shellArgs,env }).show();return;
      }
      if (message.type === 'cancel') {
        if (!this.agent || this.state.status !== 'busy' || !this.state.sessionId) return;
        if(this.agent instanceof RemoteAgent){await this.agent.cancel(this.state.sessionId);return;}
        this.stopping = true; this.cancelPermissions(); this.emit();
        if (!this.prompting) return;
        await this.agent.cancel(this.state.sessionId);
        if (this.cancelTimer) clearTimeout(this.cancelTimer);
        if (this.state.status !== 'busy') return;
        this.cancelTimer = setTimeout(() => {
          this.disconnect(); this.state.status = 'disconnected'; this.state.error = 'Agent 未在 5 秒内响应取消，连接已关闭。可从历史记录恢复。'; void this.save().catch(error => { this.state.error = String(error); this.emit(); }); this.emit();
        }, 5000); return;
      }
      if (message.type === 'permission' && this.agent instanceof RemoteAgent) {await this.agent.permission(message.id,message.optionId);return;}
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
      if (message.type === 'open') { await openWorkspaceLink(this.cwd,message.url,message.line); return; }
      if (message.type === 'diff') { await this.documents.open(this.state.sessionId,this.state.entries.find(e=>e.id===message.id),message.index); return; }
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
        if(this.state.attachments.some(a=>a.kind==='image')&&!this.agent.info?.agentCapabilities?.promptCapabilities?.image)throw new Error('当前 Agent 未声明图片支持，请切换支持图片的 Agent。');
        const agent = this.agent, generation = this.generation;
        const settingsBefore=JSON.stringify(modelPreferences(this.state));
        if(generation!==this.generation || agent!==this.agent)throw new Error('连接状态已改变，请重试。');
        const prompt: acp.ContentBlock[] = message.text.trim()?[{ type: 'text', text: message.text }]:[];
        const attached = this.state.attachments;
        for (const a of attached) {
          if(a.kind==='image'){prompt.push({type:'image',data:a.data,mimeType:a.mimeType});continue;}
          if (agent.info?.agentCapabilities?.promptCapabilities?.embeddedContext) prompt.push({ type: 'resource', resource: { uri: a.uri, mimeType: 'text/plain', text: a.text } });
          else prompt.push({ type: 'text', text: `\n附加代码上下文：${a.name} (${a.uri})\n${a.text}` });
        }
        const contextBlocks = structuredClone(prompt);
        checkPromptSize(prompt);
        this.state.entries.push({ id: nextId(), role: 'user', contextBlocks, text: message.text + (attached.length ? '\n\n' + attached.map(a => `📎 ${a.name}`).join(' · ') : '') });
        this.state.attachments = []; this.state.status = 'busy'; this.stopping = false;
        this.emit();
        try {
          await this.save();
          await this.view?.webview.postMessage({ type: 'sent' });
          if (this.stopping || generation !== this.generation) {
            if (generation === this.generation) this.state.entries.push({ id: nextId(), role: 'notice', text: '本轮已停止，消息尚未发送给 Agent。' });
            return;
          }
          await this.rememberSettings();
          const turnState=this.state;
          const changes=agent instanceof RemoteAgent?undefined:await WorkspaceDiff.begin(this.cwd);
          let response:acp.PromptResponse;
          try {
            this.prompting = true;
            response=this.stopping||generation!==this.generation?{stopReason:'cancelled'}:await agent.prompt(this.state.sessionId!,prompt);
            if(changes&&this.state===turnState&&response.stopReason!=='end_turn')this.state.entries.push({id:nextId(),role:'notice',text:`本轮结束：${response.stopReason}`});
          } finally {
            this.prompting=false;clearTimeout(this.cancelTimer);
            if(changes) {
              if(agent instanceof AgentProcess&&agent.isClosed)await agent.stop();
              const summary=await changes.finish();
              if(!this.disposed&&this.state===turnState){this.state.entries.push(summary);await this.save();}
            }
          }
          if(agent instanceof RemoteAgent)await agent.sync();
        } catch (error) {
          if (generation === this.generation) throw error;
        } finally {
          if (generation === this.generation) {
            if (this.cancelTimer) clearTimeout(this.cancelTimer);
            this.stopping = false; this.prompting = false; this.cancelPermissions();
            try {
              await this.refreshTelemetry(true);
              if(this.agent&&settingsBefore!==JSON.stringify(modelPreferences(this.state)))await this.rememberSettings();
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
    this.serviceClient.dispose();
    this.historyStore.dispose();
    if (this.timer) clearTimeout(this.timer);
    this.resources.forEach(r => r.dispose());
  }
}
