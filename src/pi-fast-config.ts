import { RequestError } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { PiProcess } from './pi-rpc-types';
import { nativePath } from './native-branch';
import { FAST_COMMAND, FAST_ENTRY, fastEnabled, supportsFast } from './pi-fast-mode';

/** Pi buffers setup-only entries until a conversation exists. Restore only that empty-session case. */
export async function restoreEmptyFastConfig(proc: PiProcess, saved: unknown): Promise<void> {
  if (saved === undefined) return;
  if (saved !== 'on' && saved !== 'off') throw new Error('Fast mode 索引设置格式不受支持');
  const entries = await proc.request({ type: 'get_entries' });
  if (!entries.success) throw new Error(entries.error || 'Pi 无法读取原生会话树');
  const branch = nativePath(entries.data.entries, entries.data.leafId);
  if (
    branch.some(
      (e) =>
        (e.type === 'custom' && e.customType === FAST_ENTRY) ||
        (e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant')),
    )
  )
    return;
  if (await fastConfig(proc)) await setFastConfig(proc, saved);
}

export async function fastConfig(proc: PiProcess): Promise<acp.SessionConfigOption | undefined> {
  const state = await proc.getState();
  if (!supportsFast(state.model)) return;
  const commands = await proc.request({ type: 'get_commands' });
  if (!commands.success || !commands.data.commands.some((c) => c.name === FAST_COMMAND))
    throw new Error('Pi 未加载 Fast mode 扩展，请检查安装与启动日志');
  const entries = await proc.request({ type: 'get_entries' });
  if (!entries.success) throw new Error(entries.error || 'Pi 无法读取原生会话树');
  return {
    id: 'fast-mode',
    name: 'Fast mode',
    description: '请求优先级服务，可能增加费用；需模型和账户支持。',
    type: 'select',
    category: 'other',
    currentValue: fastEnabled(nativePath(entries.data.entries, entries.data.leafId)) ? 'on' : 'off',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'On' },
    ],
  };
}
export async function setFastConfig(proc: PiProcess, value: string): Promise<void> {
  if (value !== 'on' && value !== 'off')
    throw RequestError.invalidParams({}, 'Fast mode 仅接受 on / off');
  const state = await proc.getState();
  if (state.isStreaming || state.isCompacting)
    throw RequestError.invalidParams({}, '请等待当前任务结束再切换 Fast mode');
  if (!(await fastConfig(proc)))
    throw RequestError.invalidParams({}, '当前 Pi / 模型不支持 Workbench Fast mode');
  // Confirm registration before prompt: an unknown slash command must never become a model prompt.
  await proc.prompt(`/${FAST_COMMAND} ${value}`);
  if ((await fastConfig(proc))?.currentValue !== value)
    throw RequestError.internalError({}, 'Pi 未确认 Fast mode 设置已应用');
}
