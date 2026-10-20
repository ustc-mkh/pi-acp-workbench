import { RequestError } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { NativeEntry, NativeMessage } from './native-branch';
import type {
  PiAgent,
  PiProcess,
  PiProcessFactory,
  PiSession,
  WorkbenchParams,
} from './pi-rpc-types';
import { providerError } from './adapter-errors';
import { createReadStream } from 'node:fs';
import { stat, mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { writeAtomicFile } from './atomic-json';
import { fileURLToPath } from 'node:url';
import { nativePath, nativeForkPoints, NATIVE_FORK_MARKER } from './native-branch';
import type { Inspection, Price, UsageRecord } from './telemetry';
import { validRecord, validPrice } from './telemetry';
import { fastConfig } from './pi-fast-config';
import { refreshPiModels } from './pi-context-config';
import { generatePiTitle } from './pi-title';
import { usageCursor, appendedUsage } from './pi-turn-usage';
type ModelResponse = {
  models: {
    model: string;
    price: { input: number; output: number; cache_read: number; cache_write: number } | null;
    contextWindow: number | null;
  }[];
};
export function usageRecord(
  id: string,
  sessionId: string,
  message: NativeMessage,
  fallbackModel: string,
  kind: string,
  timestamp: unknown,
): UsageRecord | undefined {
  const usage = message?.usage;
  if (!usage) return;
  const record: UsageRecord = {
    id,
    sessionId,
    model:
      message.provider && message.model ? `${message.provider}/${message.model}` : fallbackModel,
    kind,
    timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp)),
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    ...(typeof usage.cost?.total === 'number' ? { reportedCost: usage.cost.total } : {}),
  };
  return validRecord(record) ? record : undefined;
}
function historicalMessages(messages: NativeMessage[]) {
  return messages
    .filter((m) => m?.role && m.role !== 'system')
    .map((m) => {
      const { usage, provider, model, api, timestamp, ...data } = m;
      if (Array.isArray(data.content))
        data.content = data.content.filter((b) => b.type !== 'thinking');
      return data;
    });
}
/** Add negotiated ACP extension methods to the pinned upstream adapter. Prompts remain standard ACP. */
export function enhancePiAgent(Base: unknown, PiRpcProcess: unknown, Errors = RequestError) {
  // Upstream ships bundled JS without declarations. Keep the cast at this boundary.
  const Agent = Base as new (...args: unknown[]) => PiAgent;
  const Process = PiRpcProcess as PiProcessFactory;
  return class extends Agent {
    private forkWorkers = new Map<string, { dispose: () => void }>();
    private usageCache?: { key: string; records: UsageRecord[] };
    private turns = new Map<string, Set<{ cancelled: boolean }>>();
    async initialize(params: acp.InitializeRequest) {
      const result = await super.initialize(params);
      result.agentCapabilities ??= {};
      result.agentCapabilities._meta = {
        ...result.agentCapabilities._meta,
        'pi-workbench': {
          version: 1,
          inspect: true,
          nativeFork: true,
          title: true,
          models: true,
          autonomousRuns: true,
        },
      };
      return result;
    }
    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      // Register before the first await, including restore/preflight. A later
      // cancel invalidates exactly the submitted turns, not the next prompt.
      const turn = { cancelled: false };
      const turns = this.turns.get(params.sessionId) ?? new Set<{ cancelled: boolean }>();
      turns.add(turn);
      this.turns.set(params.sessionId, turns);
      let session: PiSession | undefined;
      try {
        session = await this.restoreSession(params.sessionId);
        if (turn.cancelled) return { stopReason: 'cancelled' };
        session.cancelRequested = false;
        if (await refreshPiModels(session.proc))
          await this.publishConfigOptions(session).catch(() => {});
        if (turn.cancelled) return { stopReason: 'cancelled' };
        // The pinned adapter checks this guard after its own restore await and
        // at startTurn, before clearing cancelRequested or sending to Pi.
        const cursor = await usageCursor((await session.proc.getState()).sessionFile).catch(
          () => undefined,
        );
        const response = await super.prompt(params, () => turn.cancelled);
        const usage = await appendedUsage(cursor).catch(() => undefined);
        return usage
          ? {
              ...response,
              usage: {
                ...usage,
                totalTokens:
                  usage.inputTokens +
                  usage.outputTokens +
                  usage.cachedReadTokens +
                  usage.cachedWriteTokens,
              },
            }
          : response;
      } catch (error) {
        if (
          error instanceof Error &&
          /streaming|already.*running|发送失败：/i.test(error.message)
        ) {
          throw Errors.internalError({}, '发送失败：Agent 正在工作，消息未发送，请稍后重试。');
        }
        if (turn.cancelled || session?.wasCancelRequested()) return { stopReason: 'cancelled' };
        const detail = error instanceof Error ? error.message : String(error);
        throw Errors.internalError({}, providerError(detail));
      } finally {
        turns.delete(turn);
        if (!turns.size && this.turns.get(params.sessionId) === turns)
          this.turns.delete(params.sessionId);
      }
    }
    async cancel(params: acp.CancelNotification): Promise<void> {
      for (const turn of this.turns.get(params.sessionId) ?? []) turn.cancelled = true;
      await super.cancel(params);
    }
    dispose() {
      for (const turns of this.turns.values()) for (const turn of turns) turn.cancelled = true;
      this.turns.clear();
      for (const worker of this.forkWorkers.values()) worker.dispose();
      super.dispose();
    }
    async extMethod(method: '_pi_workbench/inspect', params: WorkbenchParams): Promise<Inspection>;
    async extMethod(
      method: string,
      params: WorkbenchParams,
    ): Promise<Inspection | { sessionId?: string } | ModelResponse>;
    async extMethod(
      method: string,
      params: WorkbenchParams,
    ): Promise<Inspection | { sessionId?: string } | ModelResponse> {
      if (!method.startsWith('_pi_workbench/'))
        throw new Error(`Unsupported extension method: ${method}`);
      const session = this.sessions.get(params.sessionId);
      if (method === '_pi_workbench/cancel_fork') {
        this.forkWorkers.get(params.sessionId)?.dispose();
        return {};
      }
      if (!session) throw new Error('Unknown session');
      if (session.pendingTurn && !['_pi_workbench/inspect', '_pi_workbench/title'].includes(method))
        throw new Error('Wait for the current turn to finish before inspecting or branching.');
      if (method === '_pi_workbench/title') {
        if (
          typeof params.text !== 'string' ||
          params.text.length > 4000 ||
          typeof params.model !== 'string' ||
          params.model.length > 300
        )
          throw new Error('标题参数无效。');
        return generatePiTitle(session, params.model, params.text);
      }
      if (method === '_pi_workbench/models') {
        if (params.setContext) {
          if (
            typeof params.model !== 'string' ||
            params.model.length > 300 ||
            (params.contextWindow !== null &&
              (!Number.isSafeInteger(params.contextWindow) ||
                params.contextWindow! <= 0 ||
                params.contextWindow! > 100000000))
          )
            throw new Error('Invalid context setting');
          await refreshPiModels(session.proc, {
            model: params.model,
            contextWindow: params.contextWindow!,
          });
        } else await refreshPiModels(session.proc);
        await this.publishConfigOptions(session);
        const available = await session.proc.getAvailableModels();
        if ((available.models?.length ?? 0) > 500)
          throw new Error('Model catalogue exceeds budget');
        return {
          models: (available.models || [])
            .filter((m) => m.provider && m.id)
            .map((m) => ({
              model: `${m.provider}/${m.id}`,
              price: validPrice(m.cost)
                ? {
                    input: m.cost!.input,
                    output: m.cost!.output,
                    cache_read: m.cost!.cacheRead,
                    cache_write: m.cost!.cacheWrite,
                  }
                : null,
              contextWindow:
                Number.isSafeInteger(m.contextWindow) && m.contextWindow! > 0
                  ? m.contextWindow!
                  : null,
            })),
        };
      }
      if (method === '_pi_workbench/fork') return this.forkNative(session, params, Process);
      if (method === '_pi_workbench/inspect') return this.inspect(session, params);
      throw new Error('Unknown workbench method');
    }
    /** Republish the ACP selector catalogue after Pi reloads its model registry. */
    private async publishConfigOptions(session: PiSession) {
      const conn = this.conn;
      if (!conn) return;
      const [available, state, levels] = await Promise.all([
        session.proc.getAvailableModels().catch(() => undefined),
        session.proc.getState().catch(() => undefined),
        session.proc.getAvailableThinkingLevels?.().catch(() => [] as string[]) ??
          Promise.resolve([] as string[]),
      ]);
      const models = (available?.models || [])
        .filter((m) => m.provider && m.id)
        .map((m) => ({
          value: `${m.provider}/${m.id}`,
          name: `${m.provider}/${m.name || m.id}`,
          description: null,
        }));
      const thinking =
        state?.thinkingLevel && levels.includes(state.thinkingLevel)
          ? state.thinkingLevel
          : levels[0];
      const configOptions: Record<string, unknown>[] = [
        {
          type: 'select',
          id: 'thought_level',
          category: 'thought_level',
          name: 'Thinking',
          description: 'Set the reasoning effort for this session',
          currentValue: thinking,
          options: levels.map((id) => ({
            value: id,
            name: `Thinking: ${id}`,
            description: null,
          })),
        },
      ];
      if (models.length)
        configOptions.unshift({
          type: 'select',
          id: 'model',
          category: 'model',
          name: 'Model',
          description: 'Select the model for this session',
          currentValue:
            state?.model?.provider && state.model.id
              ? `${state.model.provider}/${state.model.id}`
              : models[0].value,
          options: models,
        });
      const fast = await fastConfig(session.proc).catch(() => undefined);
      if (fast) configOptions.push({ ...fast });
      if (thinking)
        await conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: thinking },
        });
      // Without models the catalogue would lose its model selector — an empty
      // getAvailableModels is transient, never publish a crippled catalogue.
      if (models.length)
        await conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions },
        });
    }
    private async forkNative(
      session: PiSession,
      params: WorkbenchParams,
      Process: PiProcessFactory,
    ) {
      if (this.forkWorkers.has(session.sessionId))
        throw new Error('Native fork already in progress');
      let worker: PiProcess | undefined,
        cancelled = false,
        stage: string | undefined;
      this.forkWorkers.set(session.sessionId, {
        dispose: () => {
          cancelled = true;
          worker?.dispose();
        },
      });
      try {
        const state = await session.proc.getState();
        if (cancelled) throw new Error('原生分支已取消。');
        if (state.isStreaming || state.isCompacting || !state.sessionFile)
          throw new Error('请等待原生会话空闲且历史已保存后再分支。');
        const entries = await session.proc.request({ type: 'get_entries' });
        if (cancelled) throw new Error('原生分支已取消。');
        if (!entries.success) throw new Error('当前 Pi 不支持读取原生历史节点，请更新 Pi。');
        const point = nativeForkPoints(nativePath(entries.data.entries, entries.data.leafId)).find(
          (p) => p.safe && p.entryId === params.entryId && p.hash === params.hash,
        );
        if (!point) throw new Error('原生分支位置已变化或无法安全回溯，请刷新后重试。');
        stage = await mkdtemp(join(tmpdir(), 'pi-native-fork-'));
        const stagedFile = join(stage, 'source.jsonl');
        // Opening a session may migrate old formats or append fallback settings. Never do that to the source.
        await copyFile(state.sessionFile, stagedFile);
        if (cancelled) throw new Error('原生分支已取消。');
        worker = await Process.spawn({
          cwd: session.cwd,
          sessionPath: stagedFile,
          piCommand: process.env.PI_ACP_PI_COMMAND,
          workbenchFork: fileURLToPath(new URL('./pi-native-fork.mjs', import.meta.url)),
          workbenchForkSessionDir: dirname(state.sessionFile),
        });
        if (cancelled) throw new Error('原生分支已取消。');
        await worker.prompt(
          '/workbench-native-fork ' + JSON.stringify({ entryId: point.entryId, hash: point.hash }),
        );
        const fork = await worker.getState();
        if (
          !fork.sessionId ||
          fork.sessionId === state.sessionId ||
          !fork.sessionFile ||
          fork.sessionFile === state.sessionFile
        )
          throw new Error('Pi 未创建独立的原生分支。');
        await worker.prompt(
          '/workbench-native-seal ' +
            JSON.stringify({ sourceSessionId: session.sessionId, hash: point.hash }),
        );
        const check = await worker.request({ type: 'get_entries' });
        if (
          !check.success ||
          !check.data.entries.some(
            (e) =>
              e.type === 'custom' &&
              e.customType === NATIVE_FORK_MARKER &&
              e.data?.sourceSessionId === session.sessionId,
          )
        )
          throw new Error('原生分支校验未完成，未切换会话。');
        worker.dispose();
        const child = worker.child;
        await new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('原生分支进程未退出，未切换会话。'));
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (cancelled) throw new Error('原生分支已取消。');
        if (dirname(fork.sessionFile) !== dirname(state.sessionFile))
          throw new Error('原生分支保存位置异常。');
        const raw = await readFile(fork.sessionFile, 'utf8'),
          line = raw.indexOf('\n'),
          header = JSON.parse(raw.slice(0, line));
        if (
          header.type !== 'session' ||
          header.id !== fork.sessionId ||
          header.parentSession !== stagedFile
        )
          throw new Error('原生分支文件头不匹配。');
        header.parentSession = state.sessionFile;
        await writeAtomicFile(fork.sessionFile, JSON.stringify(header) + raw.slice(line), true);
        this.store.upsert({
          sessionId: fork.sessionId,
          cwd: session.cwd,
          sessionFile: fork.sessionFile,
        });
        return { sessionId: fork.sessionId };
      } finally {
        worker?.dispose();
        this.forkWorkers.delete(session.sessionId);
        if (stage) await rm(stage, { recursive: true, force: true });
      }
    }
    private async inspect(session: PiSession, params: WorkbenchParams): Promise<Inspection> {
      if (!params.cursor) {
        await refreshPiModels(session.proc);
        // Page entry must also refresh selections/catalogue when the registry
        // reload is skipped because Pi is streaming. These RPCs are read-only.
        await this.publishConfigOptions(session).catch(() => {});
      }
      const state = await session.proc.getState();
      const model = state.model,
        modelKey = model?.provider && model?.id ? `${model.provider}/${model.id}` : 'unknown';
      const records: UsageRecord[] = [];
      let currentModel = modelKey;
      if (state.sessionFile) {
        const info = await stat(state.sessionFile).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        const key = JSON.stringify([
          session.sessionId,
          state.sessionFile,
          modelKey,
          info?.ino,
          info?.size,
          info?.mtimeMs,
          info?.ctimeMs,
        ]);
        if (this.usageCache?.key === key) records.push(...this.usageCache.records);
        else {
          const input = createReadStream(state.sessionFile, { encoding: 'utf8' });
          const lines = createInterface({ input, crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              let e: NativeEntry & NativeMessage;
              try {
                e = JSON.parse(line);
              } catch {
                continue;
              } // In-progress final lines are retried next time.
              if (e.type === 'model_change' && e.provider && e.modelId)
                currentModel = `${e.provider}/${e.modelId}`;
              if (e.message?.provider && e.message?.model)
                currentModel = `${e.message.provider}/${e.message.model}`;
              if (e.type === 'custom' && e.customType === NATIVE_FORK_MARKER) records.length = 0;
              const record = usageRecord(
                `${session.sessionId}:${e.id}`,
                session.sessionId,
                e.message || e,
                currentModel,
                e.type === 'message' ? 'inference' : e.type,
                e.message?.timestamp || e.timestamp,
              );
              if (record) records.push(record);
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          } finally {
            lines.close();
            input.destroy();
          }
          // Do not reuse a parse across an append/truncate that happened during reading.
          const after = await stat(state.sessionFile).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          });
          if (
            info &&
            after &&
            info.size === after.size &&
            info.mtimeMs === after.mtimeMs &&
            info.ctimeMs === after.ctimeMs &&
            info.ino === after.ino
          )
            this.usageCache = { key, records: [...records] };
        }
      }
      const cursor =
        typeof params.cursor === 'number' &&
        Number.isSafeInteger(params.cursor) &&
        params.cursor >= 0
          ? params.cursor
          : 0;
      const result: Inspection = {
        records: records.slice(cursor, cursor + 500),
        model: modelKey,
        contextWindow: model?.contextWindow,
      };
      if (cursor + 500 < records.length) result.cursor = cursor + 500;
      if (!cursor) {
        const native = await session.proc.request({ type: 'get_entries' });
        if (!native.success) throw new Error('Pi 无法读取原生会话树，请检查 Pi 安装与会话文件。');
        result.forkPoints = nativeForkPoints(nativePath(native.data.entries, native.data.leafId));
        const data = await session.proc.getMessages(),
          messages = Array.isArray(data?.messages) ? data.messages : [];
        const summaries = messages.filter(
          (m) => m.role === 'compactionSummary' || m.role === 'branchSummary',
        );
        if (summaries.length) {
          const text = JSON.stringify(historicalMessages(messages));
          if (Buffer.byteLength(text) < 4 * 1024 * 1024) {
            result.context = text;
          }
        }
        const available = await session.proc.getAvailableModels();
        result.modelContexts = Object.fromEntries(
          (available?.models || [])
            .filter(
              (m) =>
                m.provider && m.id && Number.isSafeInteger(m.contextWindow) && m.contextWindow! > 0,
            )
            .map((m) => [`${m.provider}/${m.id}`, m.contextWindow!]),
        );
        result.prices = Object.fromEntries(
          (available?.models || [])
            .filter(
              (m): m is typeof m & { cost: Price } => !!(m.provider && m.id && validPrice(m.cost)),
            )
            .map((m) => [
              `${m.provider}/${m.id}`,
              { ...m.cost, source: 'Pi 模型配置', updated: new Date().toISOString().slice(0, 10) },
            ]),
        );
      }
      return result;
    }
  };
}
