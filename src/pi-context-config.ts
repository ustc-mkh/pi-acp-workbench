import type { PiProcess } from './pi-rpc-types';
import { randomUUID } from 'node:crypto';
import {
  CONTEXT_COMMAND,
  CONTEXT_ERROR,
  CONTEXT_APPLIED,
  MODEL_DEFAULTS,
  validContextWindow,
} from './pi-context-mode';
import { validProjection, type ContextProjection } from './pi-context-projection';
const applied = new WeakMap<PiProcess, ContextProjection>();
export const getPiContextAck = (proc: PiProcess) => applied.get(proc);
const defaults = new WeakMap<PiProcess, import('./pi-model-defaults').PiModelMetadata>();
export const getPiModelMetadata = (proc: PiProcess) => defaults.get(proc);
/** Never send an unregistered internal command to the model. */
export async function refreshPiModels(
  proc: PiProcess,
  setting?: { model: string; contextWindow: number | null },
  includeDefaults = false,
  contextProjection?: ContextProjection,
): Promise<boolean> {
  applied.delete(proc);
  if (includeDefaults) defaults.delete(proc);
  const state = await proc.getState();
  if (state.isStreaming || state.isCompacting) {
    if (setting) throw new Error('请等待当前任务结束再刷新模型配置。');
    return false;
  }
  const commands = await proc.request({ type: 'get_commands' });
  if (
    !commands.success ||
    !Array.isArray(commands.data?.commands) ||
    !commands.data.commands.some((c) => c.name === CONTEXT_COMMAND)
  ) {
    if (setting) throw new Error('Pi 未加载 context 配置扩展，请更新插件与服务。');
    return false;
  }
  if (setting && setting.contextWindow !== null && !validContextWindow(setting.contextWindow))
    throw new Error('context 长度必须是正整数。');
  if (setting && !validProjection(contextProjection))
    throw new Error('Context 必须通过 Workbench 模型设置统一保存。');
  const requestId = randomUUID();
  const input = setting
    ? { ...setting, requestId, includeDefaults, contextProjection }
    : { action: 'refresh', requestId, includeDefaults };
  await proc.prompt(`/${CONTEXT_COMMAND} ${Buffer.from(JSON.stringify(input)).toString('base64')}`);
  const entries = await proc.request({ type: 'get_entries' });
  if (!entries.success || !Array.isArray(entries.data?.entries))
    throw new Error('Pi 无法确认模型配置刷新结果。');
  const failure = entries.data.entries.find(
    (e) =>
      e.type === 'custom' &&
      e.customType === CONTEXT_ERROR &&
      (e.data as { requestId?: string })?.requestId === requestId,
  );
  if (failure) {
    const message = (failure.data as { error?: unknown })?.error;
    throw new Error(
      typeof message === 'string'
        ? message
        : 'Pi 模型配置刷新失败，请检查 models.json、模型权限及 Pi 版本。',
    );
  }
  if (setting && contextProjection) {
    const ack = entries.data.entries.find(
      (e) =>
        e.type === 'custom' &&
        e.customType === CONTEXT_APPLIED &&
        (e.data as { requestId?: string })?.requestId === requestId,
    )?.data as
      | { projection?: ContextProjection; model?: string; contextWindow?: number | null }
      | undefined;
    if (
      !ack ||
      ack.model !== setting.model ||
      ack.contextWindow !== setting.contextWindow ||
      ack.projection?.owner !== contextProjection.owner ||
      ack.projection?.revision !== contextProjection.revision
    )
      throw new Error('Pi 未确认 context 配置版本。');
    applied.set(proc, contextProjection);
  }
  if (setting && setting.contextWindow !== null) {
    const models = await proc.getAvailableModels();
    const model = models.models?.find((m) => `${m.provider}/${m.id}` === setting.model);
    if (model?.contextWindow !== setting.contextWindow)
      throw new Error('Pi 未确认 context 长度已应用。');
  }
  if (includeDefaults) {
    defaults.delete(proc);
    const snapshot = entries.data.entries.find(
      (e) =>
        e.type === 'custom' &&
        e.customType === MODEL_DEFAULTS &&
        (e.data as { requestId?: string })?.requestId === requestId,
    );
    const metadata = snapshot?.data as import('./pi-model-defaults').PiModelMetadata | undefined;
    if (metadata && Array.isArray(metadata.models) && metadata.models.length <= 500) {
      if (
        metadata.candidates !== undefined &&
        (!Array.isArray(metadata.candidates) || metadata.candidates.length > 20000)
      )
        throw new Error('模型目录超出上限。');
      defaults.set(proc, { models: metadata.models, candidates: metadata.candidates });
    }
  }
  return true;
}
