import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentProcess } from './agent';
import { applyUpdate, initialState, nextId } from './state';
import { contextSeed, checkPromptSize } from './context';
import { demoMarkdown } from './demo';
import type { Entry, Snapshot, UiMessage } from './shared';

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

class ChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
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
  private forgottenSessions = new Set<string>();
  private permissionResolvers = new Map<string, (response: acp.RequestPermissionResponse) => void>();
  private diffDocs = new Map<string, string>();
  private resources: vscode.Disposable[] = [];
  private log = vscode.window.createOutputChannel('Pi Agent');
  constructor(private context: vscode.ExtensionContext) {
    this.history = this.config.get<boolean>('persistHistory', true) ? context.workspaceState.get<Snapshot[]>('history', []) : [];
    if (!this.config.get('persistHistory', true)) void context.workspaceState.update('history', undefined);
    this.resources.push(this.log, vscode.workspace.registerTextDocumentContentProvider('pi-acp-diff', {
      provideTextDocumentContent: uri => this.diffDocs.get(uri.toString()) || '',
    }), vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('piAcp')) return;
      if (!this.config.get('persistHistory', true)) { this.history = []; void context.workspaceState.update('history', undefined); }
      this.emit();
    }));
  }
  private get config() { return vscode.workspace.getConfiguration('piAcp'); }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    const nonce = randomBytes(24).toString('base64');
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; img-src ${view.webview.cspSource}; connect-src 'none';"><link rel="stylesheet" href="${uri('katex.min.css')}"><link rel="stylesheet" href="${uri('style.css')}"></head><body><div id="app"></div><script nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage(message => void this.perform(message));
    view.onDidDispose(() => { listener.dispose(); this.view = undefined; });
    this.emit();
  }
  private emit() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.state.history = this.history.map(({ id, cwd, title, updated }) => ({ id, cwd, title, updated }));
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
    };
    // Bound storage without silently presenting a partial transcript as a complete one.
    if (JSON.stringify(snapshot).length > 2_000_000) {
      snapshot.contextComplete = false;
      snapshot.entries = [{ id: nextId(), role: 'notice', text: snapshot.contextPending ? '此会话过长，待同步上下文未能完整保存。请在关闭窗口前发送普通消息完成同步。' : '此会话过长，本地仅保存索引；恢复时由 Agent 重放历史。' }];
      if (snapshot.contextPending && !this.state.error && snapshot.entries[0].role === 'notice') this.state.error = snapshot.entries[0].text;
    }
    this.history = [snapshot, ...this.history.filter(s => s.id !== snapshot.id)].slice(0, 20);
    await this.context.workspaceState.update('history', this.history); this.emit();
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
    if (snapshot?.contextPending) contextSeed(snapshot.entries, snapshot.contextComplete);
    const cwd = snapshot?.cwd || await this.workspaceCwd();
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    if (snapshot && !vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === cwd)) throw new Error('请先打开该历史会话对应的工作区。');
    await this.save(); this.disconnect();
    const generation = this.generation;
    this.cwd = cwd;
    this.state = { ...initialState(), status: 'connecting', connectionAttempted: true, attachments: this.state.attachments };
    this.replay = !!snapshot;
    this.emit();
    const pending: acp.SessionNotification[] = [];
    const agent = this.createAgent(cwd, pending);
    this.agent = agent;
    try {
      const info = await agent.initialize();
      const session = await agent.createSession(snapshot?.contextPending ? undefined : snapshot?.id);
      if (snapshot?.contextPending) await this.restoreSettings(agent, session, snapshot);
      if (generation !== this.generation) return;
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
      this.state.status = 'ready'; this.replay = false; await this.save(); this.emit();
    } catch (error) {
      this.disconnect(); this.state.status = 'disconnected';
      if (snapshot) { this.state.entries = snapshot.entries; this.state.sessionId = snapshot.id; this.state.contextComplete = snapshot.contextComplete; this.state.contextPending = snapshot.contextPending; }
      throw error;
    }
  }
  private createAgent(cwd: string, pending: acp.SessionNotification[]) {
    const agent = new AgentProcess({
      cwd, command: this.config.get('command', 'pi-acp'), args: this.config.get('args', []), env: this.config.get('env', {}),
      log: text => this.log.append(text),
      update: notification => {
        if (this.agent !== agent || !this.state.sessionId) { pending.push(notification); return; }
        if (notification.sessionId === this.state.sessionId) { applyUpdate(this.state, notification.update, this.replay); this.emit(); }
      },
      permission: request => {
        if (this.agent !== agent || this.stopping || request.sessionId !== this.state.sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        const id = nextId();
        return new Promise(resolve => { this.permissionResolvers.set(id, resolve); this.state.permissions.push({ id, request }); this.emit(); });
      },
      closed: error => {
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
    try {
      await this.save();
      candidate = this.createAgent(this.cwd, pending);
      await candidate.initialize();
      session = await candidate.createSession();
      if (session.sessionId === oldId) throw new Error('Agent 未返回独立的新会话，无法安全编辑上下文。');
      await this.restoreSettings(candidate, session, previous);
      if (candidate.isClosed) throw new Error('新会话连接已关闭，上下文未修改。');
      if (generation !== this.generation) throw new Error('连接状态已改变，上下文未修改。');
    } catch (error) {
      candidate?.dispose(); this.state = previous; this.transitioning = false; this.emit(); throw error;
    }
    this.disconnect(); this.agent = candidate; this.replay = false;
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
    try { await this.save(); } finally { this.transitioning = false; this.emit(); }
  }
  private cancelPermissions() {
    for (const resolve of this.permissionResolvers.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.permissionResolvers.clear(); this.state.permissions = [];
  }
  private disconnect() {
    this.generation++; this.cancelPermissions();
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
          this.forgottenSessions.add(message.id);
          this.history = this.history.filter(item => item.id !== message.id);
        } else {
          this.history.forEach(item => this.forgottenSessions.add(item.id));
          if (this.state.sessionId) this.forgottenSessions.add(this.state.sessionId);
          this.history = [];
        }
        // Forget the local record without interrupting an active agent turn.
        await this.context.workspaceState.update('history', this.history.length ? this.history : undefined);
        this.emit(); return;
      }
      if (message.type === 'logs') { this.log.show(); return; }
      if (message.type === 'login') {
        const cwd = await this.workspaceCwd();
        vscode.window.createTerminal({ name: 'Pi Login', cwd, shellPath: this.config.get('command', 'pi-acp'), shellArgs: [...this.config.get<string[]>('args', []), '--terminal-login'], env: this.config.get('env', {}) }).show(); return;
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
      if (message.type === 'attach') { await this.attach(); return; }
      if (message.type === 'removeAttachment') { this.state.attachments = this.state.attachments.filter(a => a.id !== message.id); this.emit(); return; }
      if (message.type === 'open') { await this.openLink(message.url, message.line); return; }
      if (message.type === 'diff') { await this.openDiff(message.id, message.index); return; }
      if (message.type === 'export') { await this.exportChat(); return; }
      if (this.transitioning || this.state.status === 'busy' || this.state.status === 'connecting') return;
      this.state.error = undefined;
      if (message.type === 'connect' || message.type === 'new') {
        const pending = message.type === 'connect' && this.state.contextPending && this.state.sessionId;
        await this.start(pending ? { id: this.state.sessionId!, cwd: this.cwd, title: '', updated: Date.now(), entries: this.state.entries, contextComplete: this.state.contextComplete, contextPending: true, configs: this.state.configs, modes: this.state.modes } : undefined);
      }
      else if (message.type === 'branchMessage' || message.type === 'deleteMessage') await this.editContext(message);
      else if (message.type === 'resume') {
        const snapshot = this.history.find(s => s.id === message.id);
        if (snapshot) await this.start(snapshot);
      } else if (message.type === 'preview') {
        await this.save(); this.disconnect(); this.state = { ...initialState(), preview: true, entries: [{ id: nextId(), role: 'assistant', text: demoMarkdown }] };
        await vscode.commands.executeCommand('piAcp.chat.focus');
      } else if (message.type === 'send') {
        if (typeof message.text !== 'string' || !message.text.trim()) return;
        if (message.text.length > 500000) throw new Error('消息过长。');
        if (!this.agent || !this.state.sessionId || this.state.status !== 'ready') throw new Error('请先连接 Agent 或从历史记录恢复会话。');
        if (this.state.contextPending && message.text.trimStart().startsWith('/')) throw new Error('请先发送普通消息同步修改后的上下文，再使用 /compact 等命令。');
        const agent = this.agent, generation = this.generation;
        const seed = this.state.contextPending ? contextSeed(this.state.entries, this.state.contextComplete) : undefined;
        const prompt: acp.ContentBlock[] = [{ type: 'text', text: message.text }];
        const attached = this.state.attachments;
        for (const a of attached) {
          if (agent.info?.agentCapabilities?.promptCapabilities?.embeddedContext) prompt.push({ type: 'resource', resource: { uri: a.uri, mimeType: 'text/plain', text: a.text } });
          else prompt.push({ type: 'text', text: `\n附加代码上下文：${a.name} (${a.uri})\n${a.text}` });
        }
        const contextBlocks = structuredClone(prompt);
        if (seed) prompt.unshift(seed);
        checkPromptSize(prompt);
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
            this.state.status = this.agent ? 'ready' : 'disconnected'; await this.save(); this.emit();
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
  private async exportChat() {
    const uri = await vscode.window.showSaveDialog({ defaultUri: this.cwd ? vscode.Uri.file(path.join(this.cwd, 'pi-conversation.md')) : undefined, filters: { Markdown: ['md'] } });
    if (!uri) return;
    const text = this.state.entries.map(e => e.role === 'tool' ? `### 工具：${e.tool.title}\n\n状态：${e.tool.status}` : `## ${e.role}\n\n${e.text}`).join('\n\n---\n\n');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  }
  dispose() {
    void this.save(); this.disconnect(); if (this.timer) clearTimeout(this.timer);
    this.resources.forEach(r => r.dispose()); this.diffDocs.clear();
  }
}
