// Pi extension: keep the fast setting on the native branch, outside model context.
import { installContextConfig, type ContextModel } from './pi-context-mode';
export const FAST_ENTRY = 'pi-acp-workbench/fast-mode';
export const FAST_COMMAND = 'workbench-fast';
export interface FastModel {
  provider?: string;
  api?: string;
}
export function supportsFast(model?: FastModel): boolean {
  return (
    (model?.provider === 'openai-codex' && model.api === 'openai-codex-responses') ||
    (model?.provider === 'openai' && model.api === 'openai-responses')
  );
}
export function fastEnabled(
  branch: { type: string; customType?: string; data?: unknown }[],
): boolean {
  let entry: (typeof branch)[number] | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === 'custom' && branch[i].customType === FAST_ENTRY) {
      entry = branch[i];
      break;
    }
  }
  if (!entry) return false;
  const data = entry.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('version' in data) ||
    data.version !== 1 ||
    !('enabled' in data) ||
    typeof data.enabled !== 'boolean'
  )
    throw new Error('Fast mode 设置格式不受支持');
  return data.enabled;
}
export interface FastContext {
  model?: FastModel;
  isIdle(): boolean;
  sessionManager: { getBranch(): { type: string; customType?: string; data?: unknown }[] };
}
export interface FastExtensionApi {
  setModel?(model: ContextModel): Promise<boolean>;
  getThinkingLevel?(): string;
  setThinkingLevel?(value: string): void;
  on(
    event: 'before_provider_request',
    handler: (event: { payload: unknown }, context: FastContext) => unknown,
  ): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, context: FastContext) => Promise<void>;
    },
  ): void;
  appendEntry(type: string, data: unknown): void;
}
export default function fastMode(pi: FastExtensionApi) {
  installContextConfig(pi);
  pi.on('before_provider_request', ({ payload }, context) => {
    if (!supportsFast(context.model) || !fastEnabled(context.sessionManager.getBranch())) return;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Fast mode 请求格式不受支持');
    return { ...payload, service_tier: 'priority' };
  });
  pi.registerCommand(FAST_COMMAND, {
    description: 'Internal: set Workbench Fast mode (priority service, may cost more)',
    handler: async (args, context) => {
      if (args !== 'on' && args !== 'off') throw new Error('Fast mode 仅接受 on / off');
      if (!context.isIdle()) throw new Error('请等待当前任务结束再切换 Fast mode');
      if (args === 'on' && !supportsFast(context.model))
        throw new Error('当前模型不支持 Fast mode');
      pi.appendEntry(FAST_ENTRY, { version: 1, enabled: args === 'on' });
    },
  });
}
