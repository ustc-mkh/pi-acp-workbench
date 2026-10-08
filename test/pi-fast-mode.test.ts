import { expect, it, vi } from 'vitest';
import fastMode, {
  FAST_ENTRY,
  fastEnabled,
  type FastExtensionApi,
  type FastContext,
} from '../src/pi-fast-mode';
import { fastConfig, setFastConfig, restoreEmptyFastConfig } from '../src/pi-fast-config';
import type { PiProcess, PiState } from '../src/pi-rpc-types';
import type { NativeEntry } from '../src/native-branch';
import { ChildProcess } from 'node:child_process';

const model = { provider: 'openai-codex', api: 'openai-codex-responses' };
const entry = (enabled: boolean) => ({
  type: 'custom',
  customType: FAST_ENTRY,
  data: { version: 1, enabled },
});

it('applies priority only when enabled on the current native branch and a supported provider', async () => {
  let hook: Parameters<FastExtensionApi['on']>[1] | undefined;
  let command: Parameters<FastExtensionApi['registerCommand']>[1] | undefined;
  const branch: ReturnType<FastContext['sessionManager']['getBranch']> = [];
  const context: FastContext = {
    model,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch },
  };
  fastMode({
    on: (_event, handler) => {
      hook = handler;
    },
    registerCommand: (_name, handler) => {
      command = handler;
    },
    appendEntry: (customType, data) => {
      branch.push({ type: 'custom', customType, data });
    },
  });
  const payload = { input: [], service_tier: 'auto' };
  expect(hook!({ payload }, context)).toBeUndefined();
  await command!.handler('on', context);
  expect(hook!({ payload }, context)).toEqual({ ...payload, service_tier: 'priority' });
  expect(payload.service_tier).toBe('auto');
  expect(
    hook!({ payload }, { ...context, model: { provider: 'anthropic', api: 'anthropic-messages' } }),
  ).toBeUndefined();
  expect(
    hook!({ payload }, { ...context, sessionManager: { getBranch: () => [] } }),
  ).toBeUndefined();
  await expect(command!.handler('yes', context)).rejects.toThrow('on / off');
  await expect(command!.handler('off', { ...context, isIdle: () => false })).rejects.toThrow(
    '当前任务',
  );
  await command!.handler('off', context);
  expect(hook!({ payload }, context)).toBeUndefined();
  expect(fastEnabled([entry(true), entry(false)])).toBe(false);
  expect(() => fastEnabled([{ ...entry(true), data: { version: 99, enabled: true } }])).toThrow(
    '格式',
  );
});

class Process implements PiProcess {
  child = new ChildProcess();
  state: PiState = { model, isStreaming: false };
  entries: NativeEntry[] = [];
  leafId: string | null | undefined;
  registered = true;
  entriesSupported = true;
  prompt = vi.fn(async (_text: string) => {
    this.entries.push({
      ...entry(_text.endsWith(' on')),
      id: String(this.entries.length),
      parentId: this.entries.at(-1)?.id ?? null,
    });
  });
  dispose() {}
  async getState() {
    return this.state;
  }
  async getMessages() {
    return { messages: [] };
  }
  async getAvailableModels() {
    return { models: [] };
  }
  request(command: {
    type: 'get_commands';
  }): Promise<{ success: true; data: { commands: { name: string }[] } }>;
  request(command: {
    type: 'get_entries';
  }): Promise<
    { success: true; data: { entries: NativeEntry[]; leafId: string | null } } | { success: false }
  >;
  async request(command: { type: 'get_commands' | 'get_entries' }) {
    if (command.type === 'get_commands')
      return {
        success: true as const,
        data: { commands: this.registered ? [{ name: 'workbench-fast' }] : [] },
      };
    if (!this.entriesSupported) return { success: false as const };
    return {
      success: true as const,
      data: {
        entries: this.entries,
        leafId: this.leafId === undefined ? (this.entries.at(-1)?.id ?? null) : this.leafId,
      },
    };
  }
}
it('round-trips Fast mode through the registered command and confirms native state', async () => {
  const proc = new Process();
  expect((await fastConfig(proc))?.currentValue).toBe('off');
  await setFastConfig(proc, 'on');
  expect((await fastConfig(proc))?.currentValue).toBe('on');
  await setFastConfig(proc, 'off');
  expect((await fastConfig(proc))?.currentValue).toBe('off');
});
it('never sends a slash prompt when Fast mode is absent, unsupported, busy or invalid', async () => {
  const proc = new Process();
  proc.registered = false;
  await expect(fastConfig(proc)).rejects.toThrow('未加载');
  await expect(setFastConfig(proc, 'on')).rejects.toThrow('未加载');
  proc.registered = true;
  proc.state.model = { provider: 'anthropic', api: 'anthropic-messages' };
  expect(await fastConfig(proc)).toBeUndefined();
  await expect(setFastConfig(proc, 'on')).rejects.toThrow('不支持');
  proc.state.model = model;
  proc.state.isStreaming = true;
  await expect(setFastConfig(proc, 'on')).rejects.toThrow('当前任务');
  proc.state.isStreaming = false;
  await expect(setFastConfig(proc, 'true')).rejects.toThrow('on / off');
  proc.entriesSupported = false;
  await expect(fastConfig(proc)).rejects.toThrow('原生会话树');
  await expect(setFastConfig(proc, 'on')).rejects.toThrow('原生会话树');
  expect(proc.prompt).not.toHaveBeenCalled();
});
it('reports a command that succeeded without persisting the requested state', async () => {
  const proc = new Process();
  proc.prompt.mockImplementation(async () => {});
  await expect(setFastConfig(proc, 'on')).rejects.toThrow('未确认');
});
it('restores empty-session settings without overriding native branch state or existing conversations', async () => {
  const proc = new Process();
  await restoreEmptyFastConfig(proc, 'on');
  expect((await fastConfig(proc))?.currentValue).toBe('on');
  proc.prompt.mockClear();
  await restoreEmptyFastConfig(proc, 'off');
  expect(proc.prompt).not.toHaveBeenCalled();
  proc.entries = [{ id: 'user', parentId: null, type: 'message', message: { role: 'user' } }];
  await restoreEmptyFastConfig(proc, 'on');
  expect(proc.prompt).not.toHaveBeenCalled();
  await expect(restoreEmptyFastConfig(proc, 'broken')).rejects.toThrow('格式');
});
it('reads the selected native branch rather than the last node of another branch', async () => {
  const proc = new Process();
  proc.entries = [
    { id: 'root', parentId: null, type: 'model_change' },
    { ...entry(true), id: 'on', parentId: 'root' },
    { ...entry(false), id: 'other', parentId: 'root' },
  ];
  proc.leafId = 'on';
  expect((await fastConfig(proc))?.currentValue).toBe('on');
  proc.leafId = 'other';
  expect((await fastConfig(proc))?.currentValue).toBe('off');
});
