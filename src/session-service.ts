// Migration-only reference for legacy fault tests. No production daemon entry
// or build uses this implementation; new service behavior belongs in rust/.
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AgentProcess, type AgentOptions } from './agent';
import { SharedHistoryStore, SessionInUseError } from './shared-history';
import { initialState, applyUpdate, nextId } from './state';
import { bindNativeForks } from './native-branch';
import { TelegramEvents, DesktopTelegramTurn } from './telegram-events';
import { RequestJournal } from './request-journal';
import { TaskQueue } from './task-queue';
import { WorkspaceDiff } from './workspace-diff';
import { SessionPreferences, modelPreferences } from './session-preferences';
import { applyPreferences } from './session-configuration';
import {
  serviceCommand,
  durableCommand,
  type ServiceCommand,
  type ServiceConfig,
  type ServiceState,
} from './session-protocol';
import type { Snapshot, ChatState } from './shared';
import type { Inspection } from './telemetry';

interface Runtime {
  snapshot: Snapshot;
  state: ChatState;
  agent?: AgentProcess;
  busy: boolean;
  cancelled?: boolean;
  prompting?: boolean;
  used: number;
  replay: boolean;
  permissions: Map<string, (option?: string) => void>;
  publication?: DesktopTelegramTurn;
  cancelTimer?: NodeJS.Timeout;
  error?: string;
}
type PromptCommand = Extract<ServiceCommand, { kind: 'prompt' }>;
type AgentCommand = Extract<ServiceCommand, { kind: 'request' }>;

/** Owns workers and session state. Queueing, idempotency, transport and file diffs are separate modules. */
export class SessionService {
  private runtimes = new Map<string, Runtime>();
  private journal: RequestJournal;
  private preferences: SessionPreferences;
  private queue: TaskQueue;
  private store: SharedHistoryStore;
  private events: TelegramEvents;
  private closed = false;
  private sweeping = false;
  private timer: NodeJS.Timeout;
  private allocation: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    private config: ServiceConfig,
    private broadcast: (event: unknown) => void,
    private report: (error: unknown) => void,
    private makeAgent: (options: AgentOptions) => AgentProcess = (o) => new AgentProcess(o),
  ) {
    this.store = new SharedHistoryStore(join(root, 'history'), (id) => {
      const r = this.runtimes.get(id);
      if (r) {
        r.error = '会话锁失效';
        r.agent?.dispose();
      }
    });
    this.preferences = new SessionPreferences(join(root, 'preferences'));
    this.events = new TelegramEvents(join(root, 'telegram', 'events'));
    this.journal = new RequestJournal(join(root, 'service', 'requests'));
    this.queue = new TaskQueue(config.maxWorkers);
    this.timer = setInterval(
      () => {
        if (this.sweeping) return;
        this.sweeping = true;
        void this.exclusive(async () => {
          for (const [id, r] of this.runtimes)
            if (!r.busy && Date.now() - r.used >= config.idleMs) await this.evict(id, r);
        })
          .catch(report)
          .finally(() => {
            this.sweeping = false;
          });
      },
      Math.min(config.idleMs, 30000),
    );
    this.timer.unref();
  }
  async initialize() {
    await this.journal.initialize(async (receipt) => {
      const snapshot = (await this.list()).find((s) => s.id === receipt.sessionId);
      if (snapshot)
        await this.events.write({
          id: 'service:' + receipt.id,
          sessionId: snapshot.id,
          cwd: snapshot.cwd,
          title: snapshot.title,
          sessionNumber: snapshot.sessionNumber,
          text: '',
          status: 'failed',
          error: receipt.error,
          updated: Date.now(),
        });
    });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.allocation.catch(() => {}).then(fn);
    this.allocation = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  private async evict(id: string, r: Runtime) {
    await r.agent?.stop();
    this.runtimes.delete(id);
    await this.store.release(id);
  }
  private async makeRoom() {
    if (this.runtimes.size < this.config.maxWorkers) return;
    const idle = [...this.runtimes]
      .filter(([, r]) => !r.busy)
      .sort((a, b) => a[1].used - b[1].used)[0];
    if (!idle) throw new Error('工作进程均忙碌');
    await this.evict(...idle);
  }
  private spawn(
    cwd: string,
    callbacks: Pick<AgentOptions, 'update' | 'permission' | 'closed' | 'log'>,
  ) {
    return this.makeAgent({
      cwd,
      commandSetting: 'sessions.json 的 command/env',
      command: this.config.command,
      args: this.config.args,
      env: { ...this.config.env, PI_TELEGRAM_BOT_TOKEN: '' },
      ...callbacks,
    });
  }
  async list() {
    return (await this.store.list()).filter((s) => s.harness === 'pi');
  }
  private async index(id: string) {
    const snapshot = (await this.list()).find((s) => s.id === id);
    if (!snapshot) throw new Error('会话不存在');
    return snapshot;
  }
  private view(r: Runtime): ServiceState {
    return {
      snapshot: {
        ...r.snapshot,
        entries: r.state.entries,
        configs: r.state.configs,
        modes: r.state.modes,
        nativeForks: r.state.nativeForks,
      },
      busy: r.busy,
      permissions: r.state.permissions,
      commands: r.state.commands,
      error: r.error,
    };
  }
  private emit(r: Runtime) {
    this.broadcast({ type: 'state', ...this.view(r) });
  }
  private async save(r: Runtime) {
    const first = r.state.entries.find((e) => e.role === 'user');
    r.snapshot = await this.store.write({
      ...r.snapshot,
      entries: structuredClone(r.state.entries),
      configs: r.state.configs,
      modes: r.state.modes,
      commands: r.state.commands,
      nativeForks: r.state.nativeForks,
      updated: Date.now(),
      title: first?.role === 'user' ? first.text.slice(0, 70) || '新对话' : r.snapshot.title,
    });
  }
  private async runtime(id: string): Promise<Runtime> {
    return this.exclusive(async () => {
      let r = this.runtimes.get(id);
      if (r) {
        r.busy = true;
        r.cancelled = false;
        return r;
      }
      await this.makeRoom();
      const index = await this.index(id);
      await this.store.claim(id);
      try {
        const snapshot = await this.store.read(index);
        r = {
          snapshot: { ...snapshot, entries: [] },
          state: {
            ...initialState(),
            sessionId: id,
            entries: snapshot.entries,
            configs: snapshot.configs,
            modes: snapshot.modes,
            nativeForks: snapshot.nativeForks,
            commands: snapshot.commands || [],
          },
          busy: true,
          used: Date.now(),
          replay: false,
          permissions: new Map(),
        };
        this.runtimes.set(id, r);
        return r;
      } catch (error) {
        await this.store.release(id);
        throw error;
      }
    });
  }
  private permission(
    r: Runtime,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return new Promise((resolve) => {
      if (
        this.closed ||
        r.replay ||
        r.permissions.size >= 32 ||
        Buffer.byteLength(JSON.stringify(request)) > 256 * 1024
      ) {
        resolve({ outcome: { outcome: 'cancelled' } });
        return;
      }
      const id = randomUUID(),
        timer = setTimeout(() => settle(), 300000);
      const settle = (option?: string) => {
        clearTimeout(timer);
        r.permissions.delete(id);
        r.state.permissions = r.state.permissions.filter((p) => p.id !== id);
        resolve({
          outcome: option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' },
        });
        this.emit(r);
      };
      r.permissions.set(id, settle);
      r.state.permissions.push({ id, request });
      this.emit(r);
    });
  }
  private async worker(r: Runtime) {
    if (r.agent && !r.agent.isClosed) return r.agent;
    await r.agent?.stop();
    r.replay = true;
    const agent = this.spawn(r.snapshot.cwd, {
      log: this.report,
      closed: (error) => {
        r.error = error;
        this.emit(r);
      },
      update: (n) => {
        if (n.sessionId !== r.snapshot.id) return;
        if (r.replay) {
          if (n.update.sessionUpdate === 'available_commands_update')
            r.state.commands = n.update.availableCommands;
          return; // The current persisted transcript is authoritative; no old snapshot reconstruction.
        }
        applyUpdate(r.state, n.update);
        r.publication?.update();
        this.broadcast({ type: 'update', notification: n });
      },
      permission: (request) => this.permission(r, request),
    });
    r.agent = agent;
    try {
      await agent.initialize();
      const session = await agent.createSession(r.snapshot.id);
      // A freshly spawned adapter can report defaults, especially for empty sessions.
      // Restore the persisted pair before publishing state or accepting a prompt.
      const warning = await applyPreferences(agent, session, modelPreferences(r.state));
      if (warning) r.state.entries.push({ id: nextId(), role: 'notice', text: warning });
      r.state.configs = session.configOptions || r.state.configs;
      r.state.modes = session.modes || r.state.modes;
      r.replay = false;
      return agent;
    } catch (error) {
      agent.dispose();
      throw error;
    }
  }
  async state(id: string): Promise<ServiceState> {
    const index = await this.index(id),
      r = this.runtimes.get(id);
    if (r) return this.view(r);
    const snapshot = await this.store.read(index);
    return {
      snapshot,
      busy: false,
      permissions: [],
      commands: snapshot.commands || [],
      error:
        (await this.journal.last(id))?.status === 'interrupted'
          ? '上次任务被服务中断，未自动重放。'
          : undefined,
    };
  }
  async handle(method: string, params: unknown, requestId: string): Promise<unknown> {
    if (this.closed) throw new Error('会话服务正在停止');
    const command = serviceCommand(method, params);
    if (durableCommand(command))
      return this.journal.run(
        requestId,
        method,
        params,
        'sessionId' in command ? (command.sessionId ?? '') : '',
        this.queue,
        () => this.execute(command, requestId),
        this.report,
      );
    if (
      command.kind === 'remove' ||
      (command.kind === 'request' && command.method === '_pi_workbench/inspect')
    )
      return this.queue.run(command.sessionId, () => this.execute(command, requestId));
    if (command.kind === 'historyWrite')
      return this.queue.run(command.snapshot.id, () => this.execute(command, requestId));
    if (command.kind === 'historyRemove')
      return this.queue.run(command.sessionId || '', () => this.execute(command, requestId));
    return this.execute(command, requestId);
  }
  /** Queue ownership is decided once in handle(), never recursively in operation implementations. */
  private async execute(command: ServiceCommand, requestId: string): Promise<unknown> {
    if (command.kind === 'hello')
      return {
        protocolVersion: 1,
        agentInfo: { name: 'pi-session-service', title: 'Pi 会话服务', version: '1' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          _meta: { 'pi-workbench': { version: 2, inspect: true, nativeFork: true, history: true } },
        },
      };
    if (command.kind === 'list') return this.list();
    if (command.kind === 'create') return this.create(command.cwd);
    if (command.kind === 'historyWrite') return this.historyWrite(command.snapshot);
    if (command.kind === 'historyRemove') return this.historyRemove(command.sessionId);
    if (!('sessionId' in command)) throw new Error('无效服务操作');
    const id = command.sessionId;
    await this.index(id);
    if (command.kind === 'state') return this.state(id);
    if (command.kind === 'permission') {
      const r = this.runtimes.get(id),
        permission = r?.state.permissions.find((x) => x.id === command.permissionId);
      if (
        !r ||
        !permission ||
        (command.optionId !== undefined &&
          !permission.request.options.some((o) => o.optionId === command.optionId))
      )
        return false;
      r.permissions.get(command.permissionId)?.(command.optionId);
      return true;
    }
    if (command.kind === 'cancel') return this.cancel(id);
    if (command.kind === 'remove') {
      await this.exclusive(async () => {
        const r = this.runtimes.get(id);
        if (r) await this.evict(id, r);
      });
      return this.store.remove(id);
    }
    if (command.kind !== 'prompt' && command.kind !== 'request') throw new Error('无效服务操作');
    if (command.kind === 'request' && command.method === '_pi_workbench/cancel_fork')
      return this.runtimes.get(id)?.agent?.request(command.method, { sessionId: id }) || {};
    if (
      command.kind === 'request' &&
      command.method === '_pi_workbench/inspect' &&
      !command.params.force &&
      !this.runtimes.get(id)?.agent
    )
      return { records: [], contextWindow: (await this.state(id)).snapshot.contextWindow };
    return this.withWorker(id, async (r, agent) =>
      command.kind === 'prompt'
        ? this.prompt(r, agent, command, requestId)
        : this.agentRequest(r, agent, command),
    );
  }
  private async create(directory: string) {
    if (!isAbsolute(directory)) throw new Error('工作区需要绝对目录路径');
    const cwd = await realpath(directory);
    if (!(await stat(cwd)).isDirectory()) throw new Error('工作区不是目录');
    return this.exclusive(async () => {
      await this.makeRoom();
      const initial = initialState();
      const agent = this.spawn(cwd, {
        update: (n) => applyUpdate(initial, n.update, true),
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        closed: () => {},
        log: this.report,
      });
      try {
        await agent.initialize();
        const preferences = await this.preferences.read('pi');
        const session = await agent.createSession();
        const warning = await applyPreferences(agent, session, preferences);
        if (!warning)
          await this.preferences.save('pi', {
            harness: 'pi',
            configs: session.configOptions || undefined,
            modes: session.modes || undefined,
          });
        await this.store.claim(session.sessionId);
        try {
          return await this.store.write({
            id: session.sessionId,
            cwd,
            harness: 'pi',
            title: '新对话',
            updated: Date.now(),
            entries: warning ? [{ id: nextId(), role: 'notice', text: warning }] : [],
            commands: initial.commands,
            configs: session.configOptions || undefined,
            modes: session.modes || undefined,
            contextComplete: true,
          });
        } finally {
          await this.store.release(session.sessionId);
        }
      } finally {
        await agent.stop();
      }
    });
  }
  /** Protocol-v2 historyWrite: extension-side shared-history writes arrive as
   * socket commands. A session with a live runtime here is daemon-owned —
   * refuse like claim() does; otherwise the store claims briefly or accepts
   * the caller's own fresh lease (writeDelegated). */
  private async historyWrite(snapshot: Snapshot) {
    if (this.runtimes.has(snapshot.id)) throw new SessionInUseError();
    return this.store.writeDelegated(snapshot);
  }
  private async historyRemove(id?: string) {
    if (id === undefined) {
      await this.exclusive(async () => {
        for (const [sid, r] of [...this.runtimes]) await this.evict(sid, r);
      });
      return this.store.clear();
    }
    if (!(await this.store.list()).some((s) => s.id === id)) throw new Error('会话不存在');
    await this.exclusive(async () => {
      const r = this.runtimes.get(id);
      if (r) await this.evict(id, r);
    });
    return this.store.remove(id);
  }
  private async cancel(id: string) {
    this.queue.cancel(id);
    const r = this.runtimes.get(id);
    if (!r?.busy) return false;
    r.cancelled = true;
    for (const settle of r.permissions.values()) settle();
    const agent = r.agent;
    clearTimeout(r.cancelTimer);
    r.cancelTimer = setTimeout(() => {
      if (r.busy && r.agent === agent) agent?.dispose();
    }, 5000);
    r.cancelTimer.unref();
    if (r.prompting) await agent?.cancel(id);
    return true;
  }
  private async withWorker(
    id: string,
    operation: (r: Runtime, agent: AgentProcess) => Promise<unknown>,
  ) {
    const r = await this.runtime(id);
    try {
      const agent = await this.worker(r);
      r.error = undefined;
      if (r.cancelled || this.closed) return { stopReason: 'cancelled' };
      return await operation(r, agent);
    } catch (error) {
      r.error = error instanceof Error ? error.message : String(error);
      if (r.publication) {
        await r.publication.finish(r.error).catch(this.report);
        r.publication = undefined;
      }
      throw error;
    } finally {
      r.prompting = false;
      clearTimeout(r.cancelTimer);
      for (const settle of r.permissions.values()) settle();
      r.busy = false;
      r.used = Date.now();
      this.emit(r);
    }
  }
  private async agentRequest(r: Runtime, agent: AgentProcess, command: AgentCommand) {
    const { method, params, sessionId } = command;
    const forkIndex =
      method === '_pi_workbench/fork'
        ? r.state.entries.findIndex((entry) => {
            const point = r.state.nativeForks?.[entry.id];
            return point?.entryId === params.entryId && point?.hash === params.hash;
          })
        : -1;
    if (method === '_pi_workbench/fork' && forkIndex < 0) throw new Error('原生分支位置无法匹配');
    const result: any = await agent.withTimeout(
      agent.request(method, { ...params, sessionId }),
      method === '_pi_workbench/fork' ? 180000 : 30000,
    );
    if (method === '_pi_workbench/inspect') {
      const inspection = result as Inspection;
      r.state.nativeForks = bindNativeForks(r.state.entries, inspection.forkPoints || []);
      r.snapshot.contextWindow = inspection.contextWindow;
    }
    if (method === 'session/set_config_option') r.state.configs = result.configOptions;
    if (method === 'session/set_mode' && r.state.modes)
      r.state.modes.currentModeId = String(params.modeId);
    if (method === '_pi_workbench/fork') await this.saveFork(r, agent, result.sessionId, forkIndex);
    await this.save(r);
    if (method === 'session/set_config_option' || method === 'session/set_mode')
      await this.preferences.save('pi', r.state);
    return result;
  }
  private async saveFork(r: Runtime, agent: AgentProcess, id: string, index: number) {
    const snapshot: Snapshot = {
      ...r.snapshot,
      id,
      conversationId: id,
      sessionNumber: undefined,
      revision: undefined,
      entries: r.state.entries.slice(0, index + 1),
      nativeForks: undefined,
    };
    await agent.stop();
    r.agent = undefined;
    const fork = this.spawn(snapshot.cwd, {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      closed: () => {},
      log: this.report,
    });
    try {
      await fork.initialize();
      const settings = await fork.createSession(id);
      snapshot.configs = settings.configOptions || undefined;
      snapshot.modes = settings.modes || undefined;
    } finally {
      await fork.stop();
    }
    const first = snapshot.entries.find((e) => e.role === 'user');
    snapshot.title = first?.role === 'user' ? first.text.slice(0, 70) : '新分支';
    await this.store.claim(id);
    try {
      await this.store.write(snapshot);
    } finally {
      await this.store.release(id);
    }
  }
  private async prompt(r: Runtime, agent: AgentProcess, command: PromptCommand, requestId: string) {
    if (
      command.prompt.some((b) => b.type === 'image') &&
      !agent.info?.agentCapabilities?.promptCapabilities?.image
    )
      throw new Error('当前 Pi 适配器不支持图片');
    await this.preferences.save('pi', r.state);
    const settingsBefore = JSON.stringify(modelPreferences(r.state));
    r.state.entries.push({
      id: nextId(),
      role: 'user',
      text: command.prompt
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      contextBlocks: command.prompt,
    });
    await this.save(r);
    const start = r.state.entries.length;
    this.emit(r);
    r.publication = new DesktopTelegramTurn(
      this.events,
      r.state,
      r.snapshot.cwd,
      start,
      this.report,
      'service:' + requestId,
      command.source,
    );
    let saving = Promise.resolve(),
      savingBusy = false;
    const checkpoint = setInterval(() => {
      if (savingBusy) return;
      savingBusy = true;
      saving = this.save(r)
        .catch((error) => {
          r.error = String(error);
          agent.dispose();
          this.report(error);
        })
        .finally(() => {
          savingBusy = false;
        });
    }, 2000);
    try {
      const changes = await WorkspaceDiff.begin(r.snapshot.cwd);
      let result: acp.PromptResponse;
      try {
        r.prompting = true;
        result =
          r.cancelled || this.closed
            ? { stopReason: 'cancelled' }
            : await agent.prompt(command.sessionId, command.prompt);
        if (result.stopReason !== 'end_turn')
          r.state.entries.push({
            id: nextId(),
            role: 'notice',
            text: `本轮结束：${result.stopReason}`,
          });
      } catch (error) {
        r.error = r.cancelled ? undefined : error instanceof Error ? error.message : String(error);
        r.state.entries.push({
          id: nextId(),
          role: 'notice',
          text: r.cancelled ? '本轮已停止。' : `本轮失败：${r.error}`,
        });
        result = { stopReason: 'cancelled' };
      } finally {
        r.prompting = false;
        clearTimeout(r.cancelTimer);
        if (agent.isClosed) await agent.stop();
        r.state.entries.push(await changes.finish());
      }
      clearInterval(checkpoint);
      await saving;
      await this.save(r);
      if (settingsBefore !== JSON.stringify(modelPreferences(r.state)))
        await this.preferences.save('pi', r.state);
      await r.publication.finish(r.error, result.stopReason);
      r.publication = undefined;
      if (r.error) throw new Error(r.error);
      return result;
    } finally {
      clearInterval(checkpoint);
      await saving;
    }
  }
  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    const draining = this.queue.close();
    for (const r of this.runtimes.values()) {
      for (const settle of r.permissions.values()) settle();
      r.agent?.dispose();
    }
    await Promise.all([draining, this.journal.drain()]);
    await this.exclusive(async () => {
      for (const [id, r] of this.runtimes) await this.evict(id, r);
    });
    await this.store.releaseAll();
  }
}
