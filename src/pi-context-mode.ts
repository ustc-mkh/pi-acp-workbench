import { piModelsConfigPath, validContextWindow } from './pi-context-file';
export { piModelsConfigPath, validContextWindow, setModelContextFile } from './pi-context-file';
import {
  projectContext,
  readContextProfile,
  validProjection,
  ContextProjectionError,
} from './pi-context-projection';
import { piModelDefaults } from './pi-model-defaults';
import type { PiModel } from './pi-rpc-types';
export const MODEL_DEFAULTS = 'workbench-model-defaults';
export const CONTEXT_COMMAND = 'workbench-context';
export const CONTEXT_ERROR = 'workbench-context-error';
export const CONTEXT_APPLIED = 'workbench-context-applied';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export type ContextModel = PiModel;
export interface ContextApi {
  appendEntry?(type: string, data: unknown): void;
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
    getAll?(): PiModel[];
    getAvailable?(): PiModel[];
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
        const registry = ctx.modelRegistry;
        const setModel = pi.setModel.bind(pi);
        const setting = object(input) && input.action !== 'refresh';
        const file = piModelsConfigPath();
        if (setting) {
          if (
            typeof input.model !== 'string' ||
            (input.contextWindow !== null && !validContextWindow(input.contextWindow))
          )
            throw new Error('context 设置无效。');
          if (!validProjection(input.contextProjection))
            throw new ContextProjectionError('Context 必须通过 Workbench 模型设置统一保存。');
          const at = input.model.indexOf('/');
          if (
            at <= 0 ||
            !ctx.modelRegistry.find(input.model.slice(0, at), input.model.slice(at + 1))
          )
            throw new Error('模型不在当前 Pi 目录中。');
        }
        const refresh = async () => {
          await registry.refresh({ allowNetwork: false });
          const error = registry.getError?.();
          if (error) throw new Error('Pi 模型配置刷新失败，请检查 models.json。');
          if (object(input) && input.includeDefaults === true && requestId && registry.getAll) {
            const all = registry.getAll();
            const available = registry.getAvailable?.() ?? all;
            if (available.length > 500 || all.length > 20000) throw new Error('模型目录超出上限。');
            // Metadata only, never model context or billable tool output; no credentials/headers.
            pi.appendEntry?.(MODEL_DEFAULTS, {
              requestId,
              models: piModelDefaults(available, all),
            });
          }
          if (!ctx.isIdle()) throw new Error('Pi 在配置刷新期间开始运行，尚未确认 context。');
          const active = ctx.model;
          if (active?.provider && active.id) {
            const fresh = registry.find(active.provider, active.id);
            if (!fresh) throw new Error('当前模型已从 Pi 模型目录移除。');
            if (fresh.contextWindow !== active.contextWindow) {
              const thinking = pi.getThinkingLevel?.();
              if (!(await setModel(fresh))) throw new Error('Pi 无法应用刷新后的模型。');
              if (thinking) pi.setThinkingLevel?.(thinking);
            }
          }
          if (setting) {
            const at = (input.model as string).indexOf('/');
            const fresh = registry.find(
              (input.model as string).slice(0, at),
              (input.model as string).slice(at + 1),
            );
            if (
              !fresh ||
              (input.contextWindow !== null && fresh.contextWindow !== input.contextWindow)
            )
              throw new ContextProjectionError('Pi 未确认请求的 context 值。');
          }
        };
        if (setting && validProjection(input.contextProjection)) {
          await projectContext(
            file,
            input.model as string,
            input.contextWindow as number | null,
            input.contextProjection,
            refresh,
            () => ctx.isIdle(),
          );
          pi.appendEntry?.(CONTEXT_APPLIED, {
            requestId,
            model: input.model,
            contextWindow: input.contextWindow,
            projection: input.contextProjection,
          });
        } else await readContextProfile(file, refresh);
      } catch (error) {
        // Pi reports extension-command failures through UI notifications, not RPC errors.
        // Record only failures so regular refreshes do not grow the native session tree.
        if (requestId)
          pi.appendEntry?.(CONTEXT_ERROR, {
            requestId,
            error:
              error instanceof ContextProjectionError
                ? error.message
                : 'Pi 模型配置刷新失败，请检查 models.json、模型权限及 Pi 版本。',
          });
        throw error;
      }
    },
  });
}
