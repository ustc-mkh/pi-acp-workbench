import * as vscode from 'vscode';
import type * as acp from '@agentclientprotocol/sdk';
import { RemoteAgent, type Agent } from './remote-agent';
import type { ServiceState } from './session-protocol';
import { initialState, nextId } from './state';
import { HARNESSES, harnessKey, isHarnessId, snapshotHarness, type HarnessId } from './harness';
import { demoMarkdown } from './demo';
import type { Snapshot, UiMessage } from './shared';
import type { ChatProvider } from './extension';

type SessionCoordinatorHost = Pick<
  ChatProvider,
  | 'harness'
  | 'inspecting'
  | 'refreshHistory'
  | 'state'
  | 'transientSnapshots'
  | 'harnessAttachments'
  | 'disconnect'
  | 'persistence'
  | 'cwd'
  | 'contextWindow'
  | 'conversationId'
  | 'telemetry'
  | 'autoConnectHandled'
  | 'context'
  | 'emit'
  | 'transitioning'
  | 'lifecycle'
  | 'agent'
  | 'generation'
  | 'replay'
  | 'createAgent'
  | 'refreshTelemetry'
  | 'applyServiceState'
  | 'config'
  | 'contextAbort'
  | 'cancelPermissions'
  | 'forgottenSessions'
  | 'history'
  | 'serviceClient'
  | 'stateEncoder'
  | 'perform'
  | 'start'
>;

/** Coordinates session selection, attachment and native branching using the current UI state. */
export class SessionCoordinator {
  constructor(private readonly host: SessionCoordinatorHost) {}

  async selectHarness(harness: HarnessId) {
    if (harness === this.host.harness) return;
    if (this.host.inspecting) await this.host.inspecting;
    await this.host.refreshHistory();
    if (this.host.state.sessionId && !this.host.state.preview) {
      const snapshot = this.currentSnapshot();
      if (snapshot) this.host.transientSnapshots.set(this.host.harness, structuredClone(snapshot));
      if (!this.host.state.readOnly) await this.rememberActive();
    }
    this.host.harnessAttachments.set(this.host.harness, this.host.state.attachments);
    this.host.disconnect();
    await this.host.persistence.pending;
    this.host.harness = harness;
    this.host.cwd = '';
    this.host.contextWindow = undefined;
    this.host.conversationId = undefined;
    this.host.state = {
      ...initialState(),
      harness,
      attachments: this.host.harnessAttachments.get(harness) || [],
    };
    this.host.telemetry.reset(harness);
    this.host.autoConnectHandled = true;
    await this.host.context.workspaceState.update('selectedHarness', harness);
    const previous = this.lastSnapshot() || this.host.transientSnapshots.get(harness);
    if (previous) {
      const snapshot = previous.stored ? await this.readSnapshot(previous) : previous;
      this.host.cwd = snapshot.cwd;
      this.host.contextWindow = snapshot.contextWindow;
      this.host.conversationId = snapshot.conversationId;
      this.host.state = {
        ...this.host.state,
        sessionId: snapshot.id,
        sessionNumber: snapshot.sessionNumber,
        entries: structuredClone(snapshot.entries),
        configs: snapshot.configs,
        modes: snapshot.modes,
        contextComplete: snapshot.contextComplete,
        usage: snapshot.usage,
        readOnly: true,
        connectionAttempted: true,
      };
    }
    this.host.emit();
  }

  async start(target: Snapshot | 'new') {
    if (this.host.transitioning) return;
    this.host.autoConnectHandled = true;
    this.host.state.connectionAttempted = true;
    this.host.lifecycle.transition(true);
    try {
      await this.startSession(target);
    } finally {
      this.host.lifecycle.transition(false);
    }
  }

  async startSession(target: Snapshot | 'new') {
    let snapshot = target === 'new' ? undefined : target;
    if (this.host.state.status === 'busy' || this.host.state.status === 'connecting') return;
    if (snapshot && snapshotHarness(snapshot) !== this.host.harness)
      await this.selectHarness(snapshotHarness(snapshot));
    if (
      snapshot?.id === this.host.state.sessionId &&
      this.host.agent &&
      !this.host.agent.isClosed &&
      this.host.state.status === 'ready'
    )
      return;
    const cwd = snapshot?.cwd || (await this.workspaceCwd());
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    if (snapshot && !vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === cwd)) {
      await this.host.refreshHistory();
      this.parkActive();
      snapshot = await this.readSnapshot(snapshot);
      this.host.cwd = cwd;
      this.showReadOnlySnapshot(snapshot, '只读查看：请打开此会话对应的工作区后再继续对话。');
      this.host.emit();
      return;
    }
    if (this.host.inspecting) await this.host.inspecting;
    if (snapshot) snapshot = await this.readSnapshot(snapshot);
    const attachments =
      !this.host.state.sessionId || snapshot?.id === this.host.state.sessionId
        ? this.host.state.attachments
        : [];
    this.parkActive();
    const generation = this.host.generation;
    this.host.cwd = cwd;
    this.host.contextWindow = snapshot?.contextWindow;
    this.host.state = {
      ...initialState(),
      status: 'connecting',
      connectionAttempted: true,
      attachments,
      usage: snapshot?.usage,
    };
    this.host.replay = !!snapshot;
    this.host.emit();
    try {
      const agent = this.host.createAgent(cwd);
      this.host.agent = agent;
      const info = await agent.initialize();
      if (snapshot && this.host.harness !== 'pi' && !info.agentCapabilities?.loadSession) {
        this.host.disconnect();
        this.showReadOnlySnapshot(
          snapshot,
          '当前 ACP 适配器未声明 session/load 能力，仅查看本地记录。需要继续时请显式新建会话；不会自动重放历史。',
        );
        this.host.emit();
        return;
      }
      const session = await agent.createSession(snapshot?.id);
      if (generation !== this.host.generation) return;
      this.host.conversationId = snapshot?.conversationId || snapshot?.id || session.sessionId;
      this.host.state.sessionId = session.sessionId;
      this.host.state.sessionNumber = snapshot?.sessionNumber;
      this.host.state.agent = info.agentInfo?.title || info.agentInfo?.name || 'ACP Agent';
      this.host.state.modes = session.modes || snapshot?.modes;
      this.host.state.configs = session.configOptions || snapshot?.configs;
      this.host.state.nativeForks = snapshot?.nativeForks;
      if (snapshot) this.host.state.entries = structuredClone(snapshot.entries);
      this.host.state.contextComplete = true;
      this.host.state.status = 'ready';
      this.host.replay = false;
      await (agent as RemoteAgent).sync();
      await this.rememberActive();
      await this.host.refreshTelemetry();
      await this.host.refreshHistory();
      this.host.emit();
    } catch (error) {
      this.host.disconnect();
      this.host.state.status = 'disconnected';
      if (snapshot && this.host.harness !== 'pi') {
        this.host.state.readOnly = true;
      }
      if (snapshot) {
        this.host.state.configs = snapshot.configs;
        this.host.state.modes = snapshot.modes;
        this.host.state.entries = snapshot.entries;
        this.host.state.sessionId = snapshot.id;
        this.host.state.sessionNumber = snapshot.sessionNumber;
        this.host.state.contextComplete = snapshot.contextComplete;
        this.host.state.usage = snapshot.usage;
      }
      throw error;
    }
  }

  showReadOnlySnapshot(snapshot: Snapshot, error: string) {
    this.host.cwd = snapshot.cwd;
    this.host.contextWindow = snapshot.contextWindow;
    this.host.conversationId = snapshot.conversationId;
    this.host.state = {
      ...initialState(),
      harness: this.host.harness,
      sessionId: snapshot.id,
      sessionNumber: snapshot.sessionNumber,
      entries: structuredClone(snapshot.entries),
      configs: snapshot.configs,
      modes: snapshot.modes,
      nativeForks: snapshot.nativeForks,
      contextComplete: snapshot.contextComplete,
      usage: snapshot.usage,
      readOnly: true,
      connectionAttempted: true,
      error,
    };
  }

  createAgent(cwd: string) {
    const agent = new RemoteAgent(
      {
        cwd,
        harness: this.host.harness,
        closed: (error) => {
          if (this.host.agent !== agent) return;
          this.host.state.status = 'disconnected';
          this.host.state.error = error;
          this.host.state.permissions = [];
          this.host.agent = undefined;
          this.host.emit();
        },
      },
      (value) => {
        if (this.host.agent === agent) this.host.applyServiceState(value);
      },
      this.host.config.get<string>('serviceSocket') || undefined,
    );
    return agent;
  }

  async branchNative(message: Extract<UiMessage, { type: 'branchMessage' }>) {
    if (
      this.host.state.preview ||
      this.host.state.readOnly ||
      !this.host.state.sessionId ||
      message.sessionId !== this.host.state.sessionId
    )
      return;
    if (this.host.harness !== 'pi') throw new Error('此 harness 暂不支持原生分支。');
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未信任。');
    const source = this.host.agent;
    if (
      !source ||
      !(source.info?.agentCapabilities?._meta?.['pi-workbench'] as { nativeFork?: boolean })
        ?.nativeFork
    )
      throw new Error('当前适配器不支持原生分支，请使用新版内置 Pi 适配器。不会退回摘要重建。');
    const index = this.host.state.entries.findIndex((e) => e.id === message.id);
    if (index < 0 || !['user', 'assistant'].includes(this.host.state.entries[index].role)) return;
    const previous = this.host.state,
      oldId = previous.sessionId!,
      generation = this.host.generation;
    this.host.lifecycle.transition(true);
    this.host.state = { ...previous, status: 'connecting', contextOperation: { kind: 'fork' } };
    this.host.emit();
    this.host.contextAbort = new AbortController();
    const signal = this.host.contextAbort.signal;
    const cancel = () => {
      void source.request('_pi_workbench/cancel_fork', { sessionId: oldId }).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    let candidate: Agent | undefined, session: acp.NewSessionResponse;
    try {
      await this.host.refreshTelemetry(true);
      const point = this.host.state.nativeForks?.[message.id];
      if (!point)
        throw new Error(
          '无法唯一定位此消息的安全原生节点（可能是旧记录、工具中间步骤或重复文本）。不会猜测位置或重新生成摘要。',
        );
      previous.nativeForks = this.host.state.nativeForks;
      await this.host.refreshHistory();
      signal.throwIfAborted();
      const fork = await source.request<{ sessionId: string }>('_pi_workbench/fork', {
        sessionId: oldId,
        ...point,
      });
      signal.throwIfAborted();
      if (!fork.sessionId || fork.sessionId === oldId) throw new Error('Pi 未返回独立的原生分支。');
      candidate = this.host.createAgent(this.host.cwd);
      const info = await candidate.initialize();
      if (
        !(info.agentCapabilities?._meta?.['pi-workbench'] as { nativeFork?: boolean })?.nativeFork
      )
        throw new Error('目标适配器不支持原生分支，原会话未修改。');
      session = await candidate.createSession(fork.sessionId);
      // The native history determines model/thinking and compaction state at this point.
      // Do not restore the source's CURRENT settings or replay a textual history seed.
      if (candidate.isClosed || generation !== this.host.generation)
        throw new Error('连接状态已改变，未切换到分支。');

      signal.throwIfAborted();
    } catch (error) {
      candidate?.dispose();
      try {
      } finally {
        // Restore transcript/settings, but never roll back a connection or lease loss.
        this.host.state = {
          ...previous,
          status: this.host.agent === source && !source.isClosed ? 'ready' : 'disconnected',
          readOnly: previous.readOnly || this.host.state.readOnly,
          permissions: [],
        };
        this.host.lifecycle.transition(false);
        this.host.emit();
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.host.contextAbort = undefined;
      this.host.state.contextOperation = undefined;
    }
    this.parkActive(previous);
    this.host.agent = candidate;
    this.host.replay = false;

    this.host.conversationId = session.sessionId;
    this.host.state = {
      ...initialState(),
      harness: 'pi',
      status: 'ready',
      connectionAttempted: true,
      sessionId: session.sessionId,
      agent: previous.agent,
      attachments: previous.attachments,
      entries: structuredClone(previous.entries.slice(0, index + 1)),
      nativeForks: previous.nativeForks,
      contextComplete: previous.contextComplete,
      configs: session.configOptions || undefined,
      modes: session.modes || undefined,
    };
    await (candidate as RemoteAgent).sync();
    try {
      await this.rememberActive();
      await this.host.refreshTelemetry();
      await this.host.refreshHistory();
    } finally {
      this.host.lifecycle.transition(false);
      this.host.emit();
    }
  }

  parkActive(_state = this.host.state) {
    this.host.disconnect();
  }

  disconnect() {
    this.host.generation++;
    this.host.contextAbort?.abort();
    this.host.cancelPermissions();
    this.host.lifecycle.finishTurn();
    this.host.lifecycle.prompt(false);
    this.host.agent?.dispose();
    this.host.agent = undefined;
  }

  async rememberActive() {
    const id = this.host.state.sessionId;
    await this.host.context.workspaceState.update(
      harnessKey('activeSession', this.host.harness),
      id && this.host.config.get('persistHistory', true) && !this.host.forgottenSessions.has(id)
        ? id
        : null,
    );
  }

  lastSnapshot() {
    const id = this.host.context.workspaceState.get<string | null>(
      harnessKey('activeSession', this.host.harness),
    );
    const local = this.host.history.filter((s) => {
      try {
        return (
          snapshotHarness(s) === this.host.harness &&
          vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === s.cwd)
        );
      } catch {
        return false;
      }
    });
    return local.find((s) => s.id === id);
  }

  currentSnapshot(): Snapshot | undefined {
    if (!this.host.state.sessionId || this.host.state.preview)
      return this.lastSnapshot() || this.host.transientSnapshots.get(this.host.harness);
    return {
      id: this.host.state.sessionId,
      harness: this.host.harness,
      sessionNumber: this.host.state.sessionNumber,
      cwd: this.host.cwd,
      title: '',
      updated: Date.now(),
      entries: this.host.state.entries,
      contextComplete: this.host.state.contextComplete,
      nativeForks: this.host.state.nativeForks,
      configs: this.host.state.configs,
      modes: this.host.state.modes,
      contextWindow: this.host.contextWindow,
      usage: this.host.state.usage,
      conversationId: this.host.conversationId,
    };
  }

  async readSnapshot(snapshot: Snapshot) {
    const data = (
      await this.host.serviceClient.call<ServiceState>('state', { sessionId: snapshot.id })
    ).snapshot;
    if (snapshotHarness(data) !== snapshotHarness(snapshot))
      throw new Error('历史记录的 harness 不匹配。');
    return data;
  }

  async workspaceCwd() {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，才能启动本地 Agent。');
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先在 VS Code 打开一个本地项目文件夹。');
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: `选择 ${HARNESSES[this.host.harness].name} 的工作目录`,
          });
    if (!folder) throw new Error('未选择工作目录。');
    if (folder.uri.scheme !== 'file')
      throw new Error('请在本地或 Remote/SSH 扩展宿主中打开文件工作区。');
    return folder.uri.fsPath;
  }

  async onSwitchHarness(message: UiMessage & { type: 'switchHarness' }): Promise<void> {
    if (!isHarnessId(message.harness)) throw new Error('未知 harness。');
    if (
      this.host.transitioning ||
      this.host.state.status === 'busy' ||
      this.host.state.status === 'connecting'
    ) {
      this.host.emit();
      return;
    }
    if (message.harness === this.host.harness) {
      this.host.emit();
      return;
    }
    this.host.lifecycle.transition(true);
    this.host.state.status = 'connecting';
    this.host.emit();
    try {
      await this.selectHarness(message.harness);
    } finally {
      if (this.host.state.status === 'connecting')
        this.host.state.status = this.host.agent ? 'ready' : 'disconnected';
      this.host.lifecycle.transition(false);
      this.host.emit();
    }
    return;
  }

  async onReleaseSession(message: UiMessage & { type: 'releaseSession' }): Promise<void> {
    if (
      this.host.transitioning ||
      this.host.state.status === 'busy' ||
      this.host.state.status === 'connecting'
    )
      return;
    this.host.lifecycle.transition(true);
    try {
      await this.host.refreshHistory();
      this.host.disconnect();
      await this.host.persistence.pending;
      this.host.state.status = 'disconnected';
      this.host.state.readOnly = true;
    } finally {
      this.host.lifecycle.transition(false);
      this.host.emit();
    }
    return;
  }

  async onReady(message: UiMessage & { type: 'ready' }): Promise<void> {
    this.host.stateEncoder.reset();
    // Webview reloads must not reset a session or repeatedly retry a failed start.
    if (!this.host.autoConnectHandled) {
      this.host.autoConnectHandled = true;
      if (this.host.state.status === 'disconnected' && !this.host.state.preview)
        await this.host.perform({ type: 'connect' });
    }
    this.host.emit();
    return;
  }

  async onNew(message: UiMessage & { type: 'new' }): Promise<void> {
    await this.host.start('new');
  }

  async onConnect(message: UiMessage & { type: 'connect' }): Promise<void> {
    const snapshot = this.currentSnapshot();
    if (snapshot) await this.host.start(snapshot);
  }

  async onBranchMessage(message: UiMessage & { type: 'branchMessage' }): Promise<void> {
    await this.branchNative(message);
  }

  async onResume(message: UiMessage & { type: 'resume' }): Promise<void> {
    const snapshot = this.host.history.find((s) => s.id === message.id);
    if (snapshot) await this.host.start(snapshot);
  }

  async onPreview(message: UiMessage & { type: 'preview' }): Promise<void> {
    this.host.lifecycle.transition(true);
    try {
      await this.host.refreshHistory();
      this.host.disconnect();
      this.host.state = {
        ...initialState(),
        preview: true,
        entries: [{ id: nextId(), role: 'assistant', text: demoMarkdown }],
      };
      await vscode.commands.executeCommand('piAcp.chat.focus');
    } finally {
      this.host.lifecycle.transition(false);
    }
  }

  async onLogin(message: UiMessage & { type: 'login' }): Promise<void> {
    const cwd = await this.workspaceCwd();
    const shellPath =
      this.host.harness === 'pi'
        ? process.env.PI_ACP_PI_COMMAND || 'pi'
        : this.host.config.get(
            this.host.harness + '.loginCommand',
            this.host.harness === 'codex' ? 'codex' : 'claude-agent-acp',
          );
    const shellArgs =
      this.host.harness === 'codex'
        ? ['login']
        : this.host.harness === 'claude'
          ? ['--cli', '/login']
          : [];
    vscode.window
      .createTerminal({
        name: `${HARNESSES[this.host.harness].name} Login`,
        cwd,
        shellPath,
        shellArgs,
      })
      .show();
    return;
  }
}
