import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { lockSync } from 'proper-lockfile';
import { writeAtomicFileSync } from './atomic-json';
export const CONTEXT_COMMAND = 'workbench-context';
export const CONTEXT_ERROR = 'workbench-context-error';
export function piModelsConfigPath(
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
) {
  const expanded =
    agentDir === '~'
      ? homedir()
      : /^~[\\/\\\\]/.test(agentDir)
        ? join(homedir(), agentDir.slice(2))
        : agentDir;
  return join(resolve(expanded), 'models.json');
}
export const validContextWindow = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100000000;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function setModelContextFile(file: string, model: string, value: number | null) {
  const at = model.indexOf('/');
  const provider = model.slice(0, at),
    id = model.slice(at + 1);
  if (
    at <= 0 ||
    !id ||
    ['__proto__', 'constructor', 'prototype'].includes(provider) ||
    ['__proto__', 'constructor', 'prototype'].includes(id) ||
    (value !== null && !validContextWindow(value))
  )
    throw new Error('模型或 context 长度无效。');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const release = lockSync(file, { realpath: false, stale: 30000 });
  try {
    let config: unknown = {};
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Pi models.json 无法读取，未覆盖原文件。');
    }
    if (!object(config) || (config.providers !== undefined && !object(config.providers)))
      throw new Error('Pi models.json 格式无效，未覆盖原文件。');
    const providers = config.providers || {};
    if (!object(providers)) throw new Error('Pi providers 无效。');
    const p = providers[provider] || {};
    if (!object(p) || (p.modelOverrides !== undefined && !object(p.modelOverrides)))
      throw new Error('Pi 模型配置无效。');
    const overrides = p.modelOverrides || {};
    if (!object(overrides)) throw new Error('Pi 模型覆盖配置无效。');
    const previous = overrides[id] || {};
    if (!object(previous)) throw new Error('Pi 模型覆盖配置无效。');
    const next = { ...previous };
    if (value === null) delete next.contextWindow;
    else next.contextWindow = value;
    if (Object.keys(next).length) overrides[id] = next;
    else delete overrides[id];
    if (Object.keys(overrides).length) p.modelOverrides = overrides;
    else delete p.modelOverrides;
    if (Object.keys(p).length) providers[provider] = p;
    else delete providers[provider];
    config.providers = providers;
    writeAtomicFileSync(file, JSON.stringify(config, null, 2) + '\n', true);
  } finally {
    release();
  }
}
export interface ContextModel {
  provider?: string;
  id?: string;
  contextWindow?: number;
}
export interface ContextApi {
  appendEntry?(type: string, data: { requestId: string; error: string }): void;
  setModel?(model: ContextModel): Promise<boolean>;
  getThinkingLevel?(): string;
  setThinkingLevel?(value: string): void;
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: ContextContext) => Promise<void> },
  ): void;
}
export interface ContextContext {
  model?: ContextModel;
  isIdle(): boolean;
  modelRegistry?: {
    refresh(options?: { allowNetwork: boolean }): unknown;
    find(provider: string, id: string): ContextModel | undefined;
    getError?(): string | undefined;
  };
}
export function installContextConfig(pi: ContextApi) {
  pi.registerCommand(CONTEXT_COMMAND, {
    description: 'Internal: reload Pi models and update model context limits',
    handler: async (args, ctx) => {
      const input: unknown =
        args === 'refresh'
          ? { action: 'refresh' }
          : JSON.parse(Buffer.from(args, 'base64').toString('utf8'));
      const requestId =
        object(input) && typeof input.requestId === 'string' ? input.requestId : undefined;
      try {
        if (!ctx.isIdle()) throw new Error('请等待当前任务结束再修改 context 长度。');
        if (!ctx.modelRegistry || !pi.setModel)
          throw new Error('当前 Pi 未提供模型刷新 API，请升级 Pi。');
        if (!object(input) || input.action !== 'refresh') {
          if (
            !object(input) ||
            typeof input.model !== 'string' ||
            (input.contextWindow !== null && !validContextWindow(input.contextWindow))
          )
            throw new Error('context 设置无效。');
          const at = input.model.indexOf('/');
          if (
            at <= 0 ||
            !ctx.modelRegistry.find(input.model.slice(0, at), input.model.slice(at + 1))
          )
            throw new Error('模型不在当前 Pi 目录中。');
          const file = piModelsConfigPath();
          setModelContextFile(file, input.model, input.contextWindow as number | null);
        }
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        const error = ctx.modelRegistry.getError?.();
        if (error) throw new Error('Pi 模型配置刷新失败，请检查 models.json。');
        const active = ctx.model;
        if (active?.provider && active.id) {
          const fresh = ctx.modelRegistry.find(active.provider, active.id);
          if (!fresh) throw new Error('当前模型已从 Pi 模型目录移除。');
          if (fresh.contextWindow !== active.contextWindow) {
            const thinking = pi.getThinkingLevel?.();
            if (!(await pi.setModel(fresh))) throw new Error('Pi 无法应用刷新后的模型。');
            if (thinking) pi.setThinkingLevel?.(thinking);
          }
        }
      } catch (error) {
        // Pi reports extension-command failures through UI notifications, not RPC errors.
        // Record only failures so regular refreshes do not grow the native session tree.
        if (requestId)
          pi.appendEntry?.(CONTEXT_ERROR, {
            requestId,
            error: 'Pi 模型配置刷新失败，请检查 models.json、模型权限及 Pi 版本。',
          });
        throw error;
      }
    },
  });
}
