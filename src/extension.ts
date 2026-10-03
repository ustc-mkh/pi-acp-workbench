import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { SessionCache } from './session-cache';
import { validateImage, MAX_ATTACHMENT_IMAGE_BYTES } from './images';
import { AgentProcess } from './agent';
import { applyUpdate, initialState, nextId } from './state';
import { contextSeed, checkPromptSize } from './context';
import { SnapshotStore } from './snapshots';
import { prepareContext, contextBudget, checkpoint, validCheckpoint, byteSize, type Checkpoint } from './checkpoints';
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

interface CachedConversation {agent:AgentProcess;state:ReturnType<typeof initialState>;cwd:string;checkpoints:Checkpoint[];preparedContext?:string;contextWindow?:number;conversationId?:string}

class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private sessions=new SessionCache<CachedConversation>();
  private activeCacheable=true;
  private view?: vscode.WebviewView;
  private state = initialState();
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
  private saveQueue: Promise<void> = Promise.resolve();
  private checkpoints: Checkpoint[] = [];
  private preparedContext?: string;
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
    this.snapshots = new SnapshotStore(context.storageUri?.fsPath ? path.join(context.storageUri.fsPath, 'conversations') : undefined);
    this.priceOverrides = context.workspaceState.get('prices', {});
    this.statistics = {records:mergeUsage([],context.workspaceState.get('usageRecords',[])),prices:{...presetPrices,...this.priceOverrides},titles:context.workspaceState.get('usageTitles',{}),available:false};
    this.history = this.config.get<boolean>('persistHistory', true) ? context.workspaceState.get<Snapshot[]>('history', []) : [];
    if (!this.config.get('persistHistory', true)) { void context.workspaceState.update('history', undefined); void this.snapshots.clear(); }
    this.resources.push(this.log, vscode.workspace.registerTextDocumentContentProvider('pi-acp-diff', {
      provideTextDocumentContent: uri => this.diffDocs.get(uri.toString()) || '',
    }), vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('piAcp')) return;
      if(['command','args','env','useBundledAdapter'].some(key=>e.affectsConfiguration('piAcp.'+key))){this.sessions.clear();this.activeCacheable=false;}
      if (!this.config.get('persistHistory', true)) { this.history = []; void context.workspaceState.update('history', undefined); void this.snapshots.clear(); }
      this.emit();
    }));
  }
  private get config() { return vscode.workspace.getConfiguration('piAcp'); }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    const nonce = randomBytes(24).toString('base64');
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; connect-src 'none';"><link rel="stylesheet" href="${uri('katex.min.css')}"><link rel="stylesheet" href="${uri('style.css')}"></head><body><div id="app"></div><script nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage(message => void this.perform(message));
    view.onDidDispose(() => { listener.dispose(); this.view = undefined;this.sessions.clear(); });
    this.emit();
  }
  private emit() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.state.history = this.history.map(({ id, cwd, title, updated }) => ({ id, cwd, title, updated }));
      const models=this.state.configs?.filter(c=>c.category==='model'||c.id==='model').flatMap(c=>c.type==='select'?c.options.flatMap(o=>'options' in o?o.options:[o]):[]).map(o=>({id:o.value,name:o.name}));
      if(this.state.status==='ready'||this.state.status==='busy')this.statistics.models=models||[];
      this.state.statistics = this.statistics;
      this.state.showThoughts = this.config.get('showThoughts', true);
      void this.view?.webview.postMessage({ type: 'state', state: this.state });
    }, 40);
  }
  private async save() {
    if (!this.state.sessionId || this.state.preview || this.forgottenSessions.has(this.state.sessionId) || !this.config.get('persistHistory', true)) return;
    const title = this.state.entries.find(e => e.role === 'user');
    const snapshot: Snapshot = {
      id: this.state.sessionId, cwd: this.cwd, title: title && title.role === 'user' ? title.text.slice(0, 70) : '新对话',
      updated: Date.now(), entries: structuredClone(this.state.entries),
      contextComplete: this.state.contextComplete, contextPending: this.state.contextPending,
      configs: structuredClone(this.state.configs), modes: structuredClone(this.state.modes),
      checkpoints:structuredClone(this.checkpoints),preparedContext:this.preparedContext,contextWindow:this.contextWindow,conversationId:this.conversationId,
    };
    this.saveQueue = this.saveQueue.catch(()=>{}).then(async()=>{
      const index = await this.snapshots.write(snapshot);
      if(this.forgottenSessions.has(index.id) || !this.config.get('persistHistory',true)) {await this.snapshots.remove(index.id);return;}
      const next=[index,...this.history.filter(s=>s.id!==index.id)];
      this.history=next.slice(0,20);
      await this.context.workspaceState.update('history',this.history);
      for(const old of next.slice(20))await this.snapshots.remove(old.id);
      this.emit();
    });
    await this.saveQueue;
  }

  private async workspaceCwd() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，才能启动本地 Agent。');
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先在 VS Code 打开一个本地项目文件夹。');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择 Pi 的工作目录' });
    if (!folder) throw new Error('未选择工作目录。');
    if (folder.uri.scheme !== 'file') throw new Error('请在本地或 Remote/SSH 扩展宿主中打开文件工作区。');
    return folder.uri.fsPath;
  }
  snapshot() { return structuredClone(this.state); }
  private async start(snapshot?: Snapshot) {
    if (this.transitioning) return;
    this.autoConnectHandled = true;
    this.state.connectionAttempted = true;
    this.transitioning = true;
    try { await this.startSession(snapshot); } finally { this.transitioning = false; }
  }
  private async startSession(snapshot?: Snapshot) {
    if (this.state.status === 'busy' || this.state.status === 'connecting') return;
    if(snapshot?.id===this.state.sessionId && this.agent&&!this.agent.isClosed&&this.state.status==='ready')return;
    const cwd = snapshot?.cwd || await this.workspaceCwd();
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    if (snapshot && !vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === cwd)) throw new Error('请先打开该历史会话对应的工作区。');
    if(this.inspecting)await this.inspecting;
    let cached=snapshot?this.sessions.take(snapshot.id):undefined;
    if(!cached&&snapshot){snapshot=await this.snapshots.read(snapshot);if(snapshot.contextPending)contextSeed(snapshot.entries,snapshot.contextComplete);}
    try{await this.save();}catch(error){if(cached)this.sessions.put(snapshot!.id,cached,this.cacheBytes(cached));throw error;}
    if(cached?.agent.isClosed){cached=undefined;snapshot=await this.snapshots.read(snapshot!);if(snapshot.contextPending)contextSeed(snapshot.entries,snapshot.contextComplete);}
    this.parkActive();
    if(cached){
      this.agent=cached.agent;this.activeCacheable=true;this.state=cached.state;this.cwd=cached.cwd;this.checkpoints=cached.checkpoints;this.preparedContext=cached.preparedContext;this.contextWindow=cached.contextWindow;this.conversationId=cached.conversationId;this.replay=false;
      this.state.status='ready';this.emit();return;
    }
    const generation = this.generation;
    this.cwd = cwd;
    this.checkpoints = snapshot?.checkpoints || []; this.preparedContext=snapshot?.preparedContext; this.contextWindow=snapshot?.contextWindow;
    this.state = { ...initialState(), status: 'connecting', connectionAttempted: true, attachments: [] };
    this.replay = !!snapshot;
    this.emit();
    const pending: acp.SessionNotification[] = [];
    const agent = this.createAgent(cwd, pending);
    this.agent = agent;this.activeCacheable=true;
    try {
      const info = await agent.initialize();
      const session = await agent.createSession(snapshot?.contextPending ? undefined : snapshot?.id);
      if (snapshot?.contextPending) await this.restoreSettings(agent, session, snapshot);
      if (generation !== this.generation) return;
      this.conversationId=snapshot?.conversationId||snapshot?.id||session.sessionId;
      this.state.sessionId = session.sessionId; this.state.agent = info.agentInfo?.title || info.agentInfo?.name || 'ACP Agent';
      this.state.modes = session.modes || undefined; this.state.configs = session.configOptions || undefined;
      for (const notification of pending) if (notification.sessionId === session.sessionId) applyUpdate(this.state, notification.update, this.replay);
      if (snapshot && (snapshot.contextComplete || !this.state.entries.length)) this.state.entries = structuredClone(snapshot.entries);
      this.state.contextComplete = snapshot ? snapshot.contextComplete === true : true;
      this.state.contextPending = snapshot?.contextPending || false;
      if (snapshot?.contextPending) {
        this.state.usage = undefined;
        this.history = this.history.filter(s => s.id !== snapshot.id);
        this.forgottenSessions.add(snapshot.id);
      }
      this.state.status = 'ready'; this.replay = false; await this.refreshTelemetry(); await this.save(); if(snapshot?.contextPending)await this.snapshots.remove(snapshot.id); this.emit();
    } catch (error) {
      this.disconnect(); this.state.status = 'disconnected';
      if (snapshot) { this.state.entries = snapshot.entries; this.state.sessionId = snapshot.id; this.state.contextComplete = snapshot.contextComplete; this.state.contextPending = snapshot.contextPending; }
      throw error;
    }
  }
  private createAgent(cwd: string, pending: acp.SessionNotification[]) {
    const command=this.config.get('command','pi-acp'), args=this.config.get<string[]>('args',[]);
    const bundled=command==='pi-acp' && !args.length && this.config.get('useBundledAdapter',true);
    const agent = new AgentProcess({
      cwd, command:bundled ? process.execPath : command, args:bundled ? [path.join(this.context.extensionUri.fsPath,'dist','pi-adapter.mjs')] : args, env:{...this.config.get<Record<string,string>>('env',{}),...(bundled ? {ELECTRON_RUN_AS_NODE:'1'} : {})},
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
        void this.save(); this.emit();
      },
    });
    return agent;
  }
  private async restoreSettings(agent: AgentProcess, session: acp.NewSessionResponse, previous: Pick<Snapshot, 'configs' | 'modes'>) {
    // Set the model first: changing it can replace the available reasoning options.
    const configs = [...previous.configs || []].sort((a, b) => Number(b.category === 'model') - Number(a.category === 'model'));
    for (const config of configs) {
      const target = session.configOptions?.find(c => c.id === config.id);
      if (target?.currentValue === config.currentValue) continue;
      if (!target || config.type !== 'select' || target.type !== 'select' || !target.options.flatMap(o => 'options' in o ? o.options : [o]).some(o => o.value === config.currentValue)) {
        throw new Error(`无法在新会话中保留设置「${config.name}」，上下文未修改。`);
      }
      const response = await agent.withTimeout(agent.connection.agent.request('session/set_config_option', { sessionId: session.sessionId, configId: config.id, value: config.currentValue }));
      session.configOptions = response.configOptions;
    }
    const mode = previous.modes?.currentModeId;
    if (mode && session.modes?.currentModeId !== mode) {
      if (!session.modes?.availableModes.some(m => m.id === mode)) throw new Error('无法保留当前会话模式，上下文未修改。');
      await agent.withTimeout(agent.connection.agent.request('session/set_mode', { sessionId: session.sessionId, modeId: mode }));
      session.modes.currentModeId = mode;
    }
  }
  private workbenchCapable(agent=this.agent) {
    const meta=agent?.info?.agentCapabilities?._meta?.['pi-workbench'] as {version?:number}|undefined;
    return meta?.version===1;
  }
  private async recordUsage(records: UsageRecord[]) {
    this.statistics.records=mergeUsage(this.statistics.records,records.map(r=>({...r,sessionId:this.conversationId||r.sessionId})));
    const first=this.state.entries.find(e=>e.role==='user');
    if(this.state.sessionId)this.statistics.titles[this.conversationId||this.state.sessionId]=this.config.get('persistHistory',true)&&first?.role==='user'?first.text.slice(0,70):`会话 ${this.state.sessionId.slice(0,8)}`;
    await this.context.workspaceState.update('usageRecords',this.statistics.records);
    await this.context.workspaceState.update('usageTitles',this.statistics.titles);
  }
  private async refreshTelemetry(settledTurn=false) {
    if(this.inspecting)return this.inspecting;
    const agent=this.agent, sessionId=this.state.sessionId;
    this.statistics.available=this.workbenchCapable(agent);
    if(!agent || !sessionId || !this.statistics.available || this.state.status==='busy' && !settledTurn)return;
    const entries=structuredClone(this.state.entries);
    this.inspecting=(async()=>{
      try {
        let cursor:number|undefined;
        do {
          const data=await metadataDeadline(agent.connection.agent.request<Inspection>('_pi_workbench/inspect',{sessionId,cursor}));
          if(this.agent!==agent||this.state.sessionId!==sessionId)return;
          await this.recordUsage(data.records||[]);
          if(!cursor) {
            if(data.contextWindow && Number.isFinite(data.contextWindow) && data.contextWindow>0)this.contextWindow=data.contextWindow;
            for(const [key,value] of Object.entries(data.prices||{}))if(validPrice(value)&&!priceFor(key,presetPrices)&&!['__proto__','constructor','prototype'].includes(key))this.modelPrices[key]=value;
            this.statistics.prices={...presetPrices,...this.modelPrices,...this.priceOverrides};
            // Capture the effective native context only at a stable transcript boundary.
            if(!this.state.contextPending && (this.state.status!=='busy'||settledTurn) && data.context && data.checkpointId && this.state.contextComplete && JSON.stringify(entries)===JSON.stringify(this.state.entries) && !this.checkpoints.some(cp=>cp.id===data.checkpointId)) {
              this.checkpoints.push(checkpoint(entries,data.context,'pi',data.checkpointId));this.checkpoints=this.checkpoints.slice(-24);
            }
          }
          if(data.cursor!==undefined && (!Number.isSafeInteger(data.cursor)||data.cursor<=(cursor||0)))throw new Error('Invalid usage pagination');
          cursor=data.cursor;
        } while(cursor!==undefined);
        this.statistics.note=undefined;
      } catch(error) {this.statistics.note=`用量读取未完成：${error instanceof Error?error.message:String(error)}`;}
      finally {this.emit();}
    })();
    try{await this.inspecting;}finally{this.inspecting=undefined;}
  }
  private async prepareEditedContext(entries:Entry[],signal:AbortSignal) {
    const agent=this.agent, sessionId=this.state.sessionId;
    const summarize=this.workbenchCapable(agent)&&agent&&sessionId ? async(text:string,limit:number)=>{
      const result=await agent.connection.agent.request<{text:string;records:UsageRecord[]}>('_pi_workbench/summarize',{sessionId,text,limit});
      await this.recordUsage(result.records||[]);return result.text;
    }:undefined;
    return prepareContext(entries,this.state.contextComplete,this.checkpoints,contextBudget(this.contextWindow),summarize,(done,total)=>{
      this.state.contextOperation={done,total};this.emit();
    },signal);
  }
  private async editContext(message: Extract<UiMessage, { type: 'branchMessage' | 'deleteMessage' }>) {
    if (this.state.preview || !this.state.sessionId || message.sessionId !== this.state.sessionId) return;
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    const index = this.state.entries.findIndex(e => e.id === message.id);
    if (index < 0 || !['user', 'assistant', 'tool'].includes(this.state.entries[index].role)) return;
    const entries: Entry[] = structuredClone(message.type === 'branchMessage' ? this.state.entries.slice(0, index + 1) : this.state.entries.filter(e => e.id !== message.id));
    contextSeed(entries, this.state.contextComplete);
    const previous = this.state, oldId = previous.sessionId!, generation = this.generation;
    this.transitioning = true;
    this.state = { ...previous, status: 'connecting' }; this.emit();
    const pending: acp.SessionNotification[] = [];
    let candidate: AgentProcess | undefined;
    let session: acp.NewSessionResponse;
    let prepared:Awaited<ReturnType<typeof prepareContext>>;
    this.contextAbort=new AbortController();
    try {
      await this.refreshTelemetry();
      await this.save();
      prepared=await this.prepareEditedContext(entries,this.contextAbort.signal);
      candidate = this.createAgent(this.cwd, pending);
      await candidate.initialize();
      session = await candidate.createSession();
      if (session.sessionId === oldId) throw new Error('Agent 未返回独立的新会话，无法安全编辑上下文。');
      await this.restoreSettings(candidate, session, previous);
      if (candidate.isClosed) throw new Error('新会话连接已关闭，上下文未修改。');
      if (generation !== this.generation) throw new Error('连接状态已改变，上下文未修改。');
      this.contextAbort.signal.throwIfAborted();
    } catch (error) {
      candidate?.dispose(); this.state = previous; this.contextAbort=undefined; this.transitioning = false; await this.refreshTelemetry(); this.emit(); throw error;
    }
    this.contextAbort=undefined;
    const keptCheckpoints=this.checkpoints.filter(cp=>validCheckpoint(cp,entries));
    if(message.type==='branchMessage')this.parkActive(previous);else this.disconnect();
    this.agent = candidate;this.activeCacheable=true; this.replay = false;
    if(message.type==='branchMessage')this.conversationId=session.sessionId;
    this.checkpoints=[...keptCheckpoints,prepared!.checkpoint].slice(-24);this.preparedContext=prepared!.text;
    this.state = { ...initialState(), status: 'ready', connectionAttempted: true, sessionId: session.sessionId,
      agent: previous.agent, attachments: previous.attachments, entries, contextPending: true,
      configs: session.configOptions || undefined, modes: session.modes || undefined };
    for (const notification of pending) {
      if (notification.sessionId === session.sessionId && ['available_commands_update', 'current_mode_update', 'config_option_update'].includes(notification.update.sessionUpdate)) applyUpdate(this.state, notification.update);
    }
    if (message.type === 'deleteMessage') {
      const forgotten = this.forgottenSessions.has(oldId);
      this.history = this.history.filter(s => s.id !== oldId); this.forgottenSessions.add(oldId);
      if (forgotten) this.forgottenSessions.add(session.sessionId);
    }
    try { await this.save(); if(message.type==='deleteMessage')await this.snapshots.remove(oldId); } finally { this.transitioning = false; this.emit(); }
  }
  private cancelPermissions() {
    for (const resolve of this.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.permissionResolvers.clear(); this.state.permissions = [];
  }
  private cacheBytes(value:CachedConversation){return byteSize(JSON.stringify({entries:value.state.entries,attachments:value.state.attachments,checkpoints:value.checkpoints,preparedContext:value.preparedContext}));}
  private parkActive(state=this.state){
    if(this.agent&&!this.agent.isClosed&&state.status==='ready'&&state.sessionId&&!state.preview&&this.activeCacheable&&this.config.get('persistHistory',true)&&!this.forgottenSessions.has(state.sessionId)){
      const cached:CachedConversation={agent:this.agent,state:{...state,statistics:undefined,history:[]},cwd:this.cwd,checkpoints:this.checkpoints,preparedContext:this.preparedContext,contextWindow:this.contextWindow,conversationId:this.conversationId};
      this.agent=undefined;this.generation++;this.sessions.put(state.sessionId,cached,this.cacheBytes(cached));
    }else this.disconnect();
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
      this.state.attachments.push({ id: nextId(), name, uri: editor.document.uri.toString(), text });
      await vscode.commands.executeCommand('piAcp.chat.focus'); this.emit();
    } catch (error) { this.state.error = String(error); this.emit(); }
  }
  async perform(message: UiMessage) {
    try {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (message.type === 'ready') {
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
        if (message.type === 'deleteHistory') {
          if (!this.history.some(item => item.id === message.id)) return;
          this.forgottenSessions.add(message.id);this.sessions.remove(message.id);
          this.history = this.history.filter(item => item.id !== message.id);
          await this.snapshots.remove(message.id);
        } else {
          this.history.forEach(item => this.forgottenSessions.add(item.id));
          if (this.state.sessionId) this.forgottenSessions.add(this.state.sessionId);
          this.history = []; this.sessions.clear();await this.snapshots.clear();
        }
        // Forget the local record without interrupting an active agent turn.
        await this.context.workspaceState.update('history', this.history.length ? this.history : undefined);
        this.emit(); return;
      }
      if(message.type==='copyConversation'){await vscode.env.clipboard.writeText(this.conversationText());return;}
      if(message.type==='cancelContext'){this.contextAbort?.abort(new Error('已取消上下文重建，原会话保留。'));if(this.agent&&this.state.sessionId)void this.agent.connection.agent.request('_pi_workbench/cancel_summary',{sessionId:this.state.sessionId}).catch(()=>{});return;}
      if(message.type==='refreshStatistics'){await this.refreshTelemetry();this.emit();return;}
      if(message.type==='setPrice'){
        if(typeof message.model!=='string'||!message.model.trim()||message.model.length>300||['__proto__','constructor','prototype'].includes(message.model))throw new Error('模型标识无效。');
        if(message.price===undefined)delete this.priceOverrides[message.model];
        else {if(!validPrice(message.price))throw new Error('价格必须为非负有限数值。');this.priceOverrides[message.model]={input:message.price.input,output:message.price.output,cacheRead:message.price.cacheRead,cacheWrite:message.price.cacheWrite,source:'用户设置'};}
        this.statistics.prices={...presetPrices,...this.modelPrices,...this.priceOverrides};await this.context.workspaceState.update('prices',this.priceOverrides);this.emit();return;
      }
      if (message.type === 'logs') { this.log.show(); return; }
      if (message.type === 'login') {
        const cwd = await this.workspaceCwd();
        const command=this.config.get('command','pi-acp'),args=this.config.get<string[]>('args',[]),env=this.config.get<Record<string,string>>('env',{});
        const bundled=command==='pi-acp'&&!args.length&&this.config.get('useBundledAdapter',true);
        vscode.window.createTerminal({ name:'Pi Login',cwd,shellPath:bundled?(env.PI_ACP_PI_COMMAND||process.env.PI_ACP_PI_COMMAND||'pi'):command,shellArgs:bundled?[]:[...args,'--terminal-login'],env }).show();return;
      }
      if (message.type === 'cancel') {
        if (!this.agent || this.state.status !== 'busy' || !this.state.sessionId) return;
        this.stopping = true; this.cancelPermissions(); this.emit();
        if (!this.prompting) return;
        await this.agent.cancel(this.state.sessionId);
        if (this.cancelTimer) clearTimeout(this.cancelTimer);
        if (this.state.status !== 'busy') return;
        this.cancelTimer = setTimeout(() => {
          this.disconnect(); this.state.status = 'disconnected'; this.state.error = 'Agent 未在 5 秒内响应取消，连接已关闭。可从历史记录恢复。'; void this.save(); this.emit();
        }, 5000); return;
      }
      if (message.type === 'permission') {
        const item = this.state.permissions.find(p => p.id === message.id);
        if (!item) return;
        if (message.optionId && !item.request.options.some(o => o.optionId === message.optionId)) return;
        this.permissionResolvers.get(message.id)?.({ outcome: message.optionId ? { outcome: 'selected', optionId: message.optionId } : { outcome: 'cancelled' } });
        this.permissionResolvers.delete(message.id); this.state.permissions = this.state.permissions.filter(p => p.id !== message.id); this.emit(); return;
      }
      if(message.type==='attachmentError'){if(message.sessionId===this.state.sessionId){this.state.error=String(message.error).slice(0,300);this.emit();}return;}
      if(message.type==='attachImages'){
        if(message.sessionId!==this.state.sessionId)throw new Error('会话已切换，请重新粘贴图片。');
        if(!Array.isArray(message.images)||!message.images.length||message.images.length+this.state.attachments.length>8)throw new Error('每条消息最多附加 8 个附件。');
        const total=message.images.reduce((n,image)=>n+validateImage(image),0)+this.state.attachments.reduce((n,a)=>n+(a.kind==='image'?Buffer.byteLength(a.data,'base64'):0),0);
        if(total>MAX_ATTACHMENT_IMAGE_BYTES)throw new Error('每条消息的图片总大小不能超过 6 MB。');
        this.state.attachments.push(...message.images.map(image=>({kind:'image' as const,id:nextId(),name:image.name.slice(0,120)||'粘贴图片',mimeType:image.mimeType,data:image.data})));this.emit();return;
      }
      if (message.type === 'attach') { await this.attach(); return; }
      if (message.type === 'removeAttachment') { this.state.attachments = this.state.attachments.filter(a => a.id !== message.id); this.emit(); return; }
      if (message.type === 'open') { await this.openLink(message.url, message.line); return; }
      if (message.type === 'diff') { await this.openDiff(message.id, message.index); return; }
      if (message.type === 'export') { await this.exportChat(); return; }
      if (this.transitioning || this.state.status === 'busy' || this.state.status === 'connecting') return;
      this.state.error = undefined;
      if (message.type === 'connect' || message.type === 'new') {
        const pending = message.type === 'connect' && this.state.contextPending && this.state.sessionId;
        await this.start(pending ? { id: this.state.sessionId!, cwd: this.cwd, title: '', updated: Date.now(), entries: this.state.entries, contextComplete: this.state.contextComplete, contextPending: true, configs: this.state.configs, modes: this.state.modes, checkpoints:this.checkpoints,preparedContext:this.preparedContext,contextWindow:this.contextWindow,conversationId:this.conversationId } : undefined);
      }
      else if (message.type === 'branchMessage' || message.type === 'deleteMessage') await this.editContext(message);
      else if (message.type === 'resume') {
        const snapshot = this.history.find(s => s.id === message.id);
        if (snapshot) await this.start(snapshot);
      } else if (message.type === 'preview') {
        await this.save(); this.disconnect(); this.state = { ...initialState(), preview: true, entries: [{ id: nextId(), role: 'assistant', text: demoMarkdown }] };
        await vscode.commands.executeCommand('piAcp.chat.focus');
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
            this.checkpoints=[...this.checkpoints,prepared.checkpoint].slice(-24);this.preparedContext=prepared.text;
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
            await this.refreshTelemetry(true);this.state.status = this.agent ? 'ready' : 'disconnected'; await this.save(); this.emit();
          }
        }
      } else if (message.type === 'mode' && this.agent && this.state.sessionId) {
        if (!this.state.modes?.availableModes.some(m => m.id === message.value)) return;
        this.state.status = 'connecting'; this.emit();
        try {
          await this.agent.withTimeout(this.agent.connection.agent.request('session/set_mode', { sessionId: this.state.sessionId, modeId: message.value }), 15000);
          this.state.modes.currentModeId = message.value;
        } finally { this.state.status = this.agent ? 'ready' : 'disconnected'; }
      } else if (message.type === 'config' && this.agent && this.state.sessionId) {
        const config = this.state.configs?.find(c => c.id === message.id);
        if (!config || config.type !== 'select') return;
        const options = config.options.flatMap(o => 'options' in o ? o.options : [o]);
        if (!options.some(o => o.value === message.value)) return;
        this.state.status = 'connecting'; this.emit();
        try {
          const response = await this.agent.withTimeout(this.agent.connection.agent.request('session/set_config_option', { sessionId: this.state.sessionId, configId: message.id, value: message.value }), 15000);
          this.state.configs = response.configOptions;
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
    const key = nextId();
    const left = vscode.Uri.from({ scheme: 'pi-acp-diff', path: `/${key}/before/${path.basename(content.path)}` });
    const right = vscode.Uri.from({ scheme: 'pi-acp-diff', path: `/${key}/after/${path.basename(content.path)}` });
    this.diffDocs.set(left.toString(), content.oldText || ''); this.diffDocs.set(right.toString(), content.newText);
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
    void this.save(); this.disconnect();this.sessions.clear(); if (this.timer) clearTimeout(this.timer);
    this.resources.forEach(r => r.dispose()); this.diffDocs.clear();
  }
}
