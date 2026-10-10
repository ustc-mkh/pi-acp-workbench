import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  setModelContextFile,
  installContextConfig,
  piModelsConfigPath,
  type ContextContext,
} from '../src/pi-context-mode';
import { refreshPiModels } from '../src/pi-context-config';
import type { PiProcess } from '../src/pi-rpc-types';
function fixture(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-context-'));
  try {
    run(join(dir, 'models.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
it('resolves custom Pi directories with the same home expansion as Pi', () => {
  expect(piModelsConfigPath('~/profile')).toBe(join(homedir(), 'profile', 'models.json'));
  expect(piModelsConfigPath('~')).toBe(join(homedir(), 'models.json'));
});
it('propagates UI-only command failures through a request-scoped checkpoint', async () => {
  let requestId: string;
  const proc = {
    getState: async () => ({}),
    prompt: async (text: string) => {
      requestId = JSON.parse(Buffer.from(text.split(' ')[1], 'base64').toString()).requestId;
    },
    request: async (command: { type: string }) => ({
      success: true,
      data:
        command.type === 'get_entries'
          ? {
              entries: [
                { type: 'custom', customType: 'workbench-context-error', data: { requestId } },
              ],
            }
          : { commands: [{ name: 'workbench-context' }] },
    }),
  } as unknown as PiProcess;
  await expect(refreshPiModels(proc)).rejects.toThrow('刷新失败');
});
it('updates only contextWindow and preserves credentials, custom models and other overrides', () =>
  fixture((file) => {
    const config = {
      providers: {
        p: {
          apiKey: 'do-not-log',
          models: [{ id: 'm' }],
          modelOverrides: {
            'group/m': { maxTokens: 100, contextWindow: 10 },
            other: { contextWindow: 200 },
          },
        },
      },
      extra: { keep: true },
    };
    writeFileSync(file, JSON.stringify(config));
    setModelContextFile(file, 'p/group/m', 2000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...config,
      providers: {
        p: {
          ...config.providers.p,
          modelOverrides: {
            ...config.providers.p.modelOverrides,
            'group/m': { maxTokens: 100, contextWindow: 2000 },
          },
        },
      },
    });
    setModelContextFile(file, 'p/group/m', null);
    expect(JSON.parse(readFileSync(file, 'utf8')).providers.p.modelOverrides['group/m']).toEqual({
      maxTokens: 100,
    });
  }));
it('removes an empty override provider on reset', () =>
  fixture((file) => {
    setModelContextFile(file, 'p/m', 100);
    setModelContextFile(file, 'p/m', null);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ providers: {} });
  }));
it('refuses malformed configuration without overwriting it', () =>
  fixture((file) => {
    for (const text of [
      '{bad',
      '[]',
      '{"providers":[]}',
      '{"providers":{"p":{"modelOverrides":[]}}}',
    ]) {
      writeFileSync(file, text);
      expect(() => setModelContextFile(file, 'p/m', 100)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  }));
it('rejects invalid windows and prototype keys', () =>
  fixture((file) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 100000001])
      expect(() => setModelContextFile(file, 'p/m', value)).toThrow();
    for (const model of ['m', '/m', 'p/', '__proto__/m', 'p/constructor'])
      expect(() => setModelContextFile(file, model, 100)).toThrow();
  }));
it('refreshes the active model through Pi API and preserves thinking', async () => {
  let handler!: (args: string, ctx: ContextContext) => Promise<void>;
  const fresh = { provider: 'p', id: 'm', contextWindow: 200 };
  const setModel = vi.fn(async () => true),
    setThinkingLevel = vi.fn(),
    refresh = vi.fn(async () => {});
  installContextConfig({
    registerCommand: (_name, c) => {
      handler = c.handler;
    },
    setModel,
    getThinkingLevel: () => 'high',
    setThinkingLevel,
  });
  await handler('refresh', {
    isIdle: () => true,
    model: { ...fresh, contextWindow: 100 },
    modelRegistry: { refresh, find: () => fresh },
  });
  expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
  expect(setModel).toHaveBeenCalledWith(fresh);
  expect(setThinkingLevel).toHaveBeenCalledWith('high');
  await handler('refresh', {
    isIdle: () => true,
    model: fresh,
    modelRegistry: { refresh, find: () => fresh },
  });
  expect(setModel).toHaveBeenCalledTimes(1);
  await expect(handler('refresh', { isIdle: () => false })).rejects.toThrow('任务');
});
it('does not turn an unregistered command into a model prompt', async () => {
  const prompt = vi.fn(),
    proc = {
      getState: async () => ({}),
      request: async () => ({ success: true, data: { commands: [] } }),
      prompt,
    } as unknown as PiProcess;
  expect(await refreshPiModels(proc)).toBe(false);
  await expect(refreshPiModels(proc, { model: 'p/m', contextWindow: 100 })).rejects.toThrow(
    '未加载',
  );
  expect(prompt).not.toHaveBeenCalled();
});
it('confirms applied metadata and rejects busy workers', async () => {
  const prompt = vi.fn(),
    proc = {
      getState: async () => ({}),
      request: async (c: { type: string }) => ({
        success: true,
        data:
          c.type === 'get_entries'
            ? { entries: [] }
            : { commands: [{ name: 'workbench-context' }] },
      }),
      prompt,
      getAvailableModels: async () => ({
        models: [{ provider: 'p', id: 'm', contextWindow: 200 }],
      }),
    } as unknown as PiProcess;
  await expect(refreshPiModels(proc, { model: 'p/m', contextWindow: 200 })).resolves.toBe(true);
  await expect(refreshPiModels(proc, { model: 'p/m', contextWindow: 100 })).rejects.toThrow(
    '未确认',
  );
  const busy = { ...proc, getState: async () => ({ isStreaming: true }) } as unknown as PiProcess;
  await expect(refreshPiModels(busy)).resolves.toBe(false);
  await expect(refreshPiModels(busy, { model: 'p/m', contextWindow: 100 })).rejects.toThrow('任务');
});
