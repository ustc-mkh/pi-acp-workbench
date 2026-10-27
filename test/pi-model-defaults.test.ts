import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { piModelDefaults } from '../src/pi-model-defaults';
import { modelDefaultKey } from '../src/workbench-model-defaults';
import { installContextConfig, MODEL_DEFAULTS, type ContextContext } from '../src/pi-context-mode';
import { getPiModelDefaults, refreshPiModels } from '../src/pi-context-config';
import type { PiProcess } from '../src/pi-rpc-types';
it('uses Pi catalogue defaults across channel spelling without matching other model variants', () => {
  const known = {
    provider: 'openai',
    id: 'GPT-6.1 Sol',
    contextWindow: 272000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  };
  const alias = {
    provider: 'wwzz',
    id: 'gpt-6.1-sol',
    contextWindow: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const [result, mini] = piModelDefaults(
    [alias, { provider: 'wwzz', id: 'gpt-6.1-sol-mini' }],
    [known, alias],
  );
  expect(result).toEqual({
    model: 'wwzz/gpt-6.1-sol',
    price: { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
    contextWindow: 272000,
  });
  expect(mini.price).toBeNull();
  expect(mini.contextWindow).toBeNull();
  expect(modelDefaultKey('openai/GPT-6.1 Sol')).toBe(modelDefaultKey('wwzz/gpt-6.1-sol'));
  expect(modelDefaultKey('gpt-6.1-sol-2026-10-01')).not.toBe(modelDefaultKey('gpt-6.1-sol'));
  expect(modelDefaultKey('gpt-61-sol')).not.toBe(modelDefaultKey('gpt-6.1-sol'));
  expect(
    piModelDefaults(
      [alias],
      [
        { ...known, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { ...alias, cost: { input: 8, output: 8, cacheRead: 8, cacheWrite: 8 } },
      ],
    )[0].price?.input,
  ).toBe(0);
});
it('reads unconfigured official metadata through the real Pi extension seam without provider credentials or model prompts', async () => {
  let handler!: (args: string, ctx: ContextContext) => Promise<void>;
  const entries: unknown[] = [];
  const alias = { provider: 'wwzz', id: 'gpt-6.1-sol', contextWindow: 128000 };
  const official = {
    provider: 'openai',
    id: 'GPT-6.1 Sol',
    contextWindow: 272000,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  };
  const registry = {
    refresh: async () => {},
    find: () => alias,
    getAll: () => [official, alias],
    getAvailable: () => [alias],
  };
  installContextConfig({
    registerCommand: (_name, c) => {
      handler = c.handler;
    },
    setModel: async () => true,
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  const proc = {
    getState: async () => ({}),
    prompt: async (text: string) => {
      expect(text.startsWith('/workbench-context ')).toBe(true);
      await handler(text.split(' ')[1], { isIdle: () => true, modelRegistry: registry });
    },
    request: async (q: { type: string }) => ({
      success: true,
      data: q.type === 'get_commands' ? { commands: [{ name: 'workbench-context' }] } : { entries },
    }),
  } as unknown as PiProcess;
  expect(await refreshPiModels(proc, undefined, true)).toBe(true);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ customType: MODEL_DEFAULTS });
  expect(getPiModelDefaults(proc)?.[0]).toMatchObject({
    model: 'wwzz/gpt-6.1-sol',
    contextWindow: 272000,
    price: { input: 2 },
  });
  expect(JSON.stringify(entries)).not.toMatch(/apiKey|authorization|headers/);
});

let isolatedProfile: string;
beforeEach(() => {
  isolatedProfile = mkdtempSync(join(tmpdir(), 'pi-context-api-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', isolatedProfile);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(isolatedProfile, { recursive: true, force: true });
});
