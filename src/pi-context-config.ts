import type { PiProcess } from './pi-rpc-types';
import { randomUUID } from 'node:crypto';
import { CONTEXT_COMMAND, CONTEXT_ERROR, validContextWindow } from './pi-context-mode';
/** Never send an unregistered internal command to the model. */
export async function refreshPiModels(
  proc: PiProcess,
  setting?: { model: string; contextWindow: number | null },
): Promise<boolean> {
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
  const requestId = randomUUID();
  const input = setting ? { ...setting, requestId } : { action: 'refresh', requestId };
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
  if (failure) throw new Error('Pi 模型配置刷新失败，请检查 models.json、模型权限及 Pi 版本。');
  if (setting && setting.contextWindow !== null) {
    const models = await proc.getAvailableModels();
    const model = models.models?.find((m) => `${m.provider}/${m.id}` === setting.model);
    if (model?.contextWindow !== setting.contextWindow)
      throw new Error('Pi 未确认 context 长度已应用。');
  }
  return true;
}
