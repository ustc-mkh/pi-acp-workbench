import { expect, it } from 'vitest';
import { enhancePiAgent } from '../src/pi-enhancements';
import { CONTEXT_APPLIED, CONTEXT_COMMAND, MODEL_DEFAULTS } from '../src/pi-context-mode';
it('negotiated model refresh and explicit context use only the registered internal extension and preserve provider defaults', async () => {
  const prompts: string[] = [];
  const entries: unknown[] = [];
  const projection = { owner: 'a'.repeat(64), revision: 1 };
  const updates: unknown[] = [];
  const model = {
    provider: 'provider',
    id: 'model',
    contextWindow: 200000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
  };
  const proc = {
    getState: async () => ({ model, isStreaming: false, isCompacting: false }),
    getAvailableModels: async () => ({ models: [model] }),
    getAvailableThinkingLevels: async () => [],
    request: async (command: { type: string }) =>
      command.type === 'get_commands'
        ? { success: true, data: { commands: [{ name: CONTEXT_COMMAND }] } }
        : { success: true, data: { entries } },
    prompt: async (text: string) => {
      prompts.push(text);
      const input = JSON.parse(Buffer.from(text.split(' ')[1], 'base64').toString());
      if (input.model) {
        model.contextWindow = input.contextWindow ?? 200000;
        entries.push({
          type: 'custom',
          customType: CONTEXT_APPLIED,
          data: {
            requestId: input.requestId,
            model: input.model,
            contextWindow: input.contextWindow,
            projection: input.contextProjection,
          },
        });
      }
    },
  };
  class Base {
    sessions = new Map([['native', { sessionId: 'native', proc }]]);
    conn = {
      sessionUpdate: async (value: unknown) => {
        updates.push(value);
      },
    };
  }
  const Agent = enhancePiAgent(Base, undefined);
  const agent = new Agent();
  const before = await agent.extMethod('_pi_workbench/models', { sessionId: 'native' });
  expect(before).toMatchObject({
    models: [
      {
        model: 'provider/model',
        contextWindow: 200000,
        price: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 },
      },
    ],
  });
  expect(prompts.every((p) => p.startsWith(`/${CONTEXT_COMMAND} `))).toBe(true);
  await agent.extMethod('_pi_workbench/models', {
    sessionId: 'native',
    setContext: true,
    model: 'provider/model',
    contextWindow: 256000,
    contextProjection: projection,
  });
  expect(model.contextWindow).toBe(256000);
  expect(updates.length).toBeGreaterThan(0);
  await expect(
    agent.extMethod('_pi_workbench/models', {
      sessionId: 'native',
      setContext: true,
      model: 'provider/model',
      contextWindow: -1,
    }),
  ).rejects.toThrow('Invalid context');
  await agent.extMethod('_pi_workbench/models', {
    sessionId: 'native',
    setContext: true,
    model: 'provider/model',
    contextWindow: null,
    contextProjection: { ...projection, revision: 2 },
  });
  expect(model.contextWindow).toBe(200000);
});

it.each([0, 501])(
  'reads profile metadata with %i alias candidates without consulting sessions',
  async (count) => {
    const entries: unknown[] = [];
    const calls: unknown[] = [];
    let disposed = false;
    const models = [
      {
        model: 'vendor/model',
        price: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
        contextWindow: 200000,
      },
    ];
    const candidates = Array.from({ length: count }, (_, i) => ({
      ...models[0],
      model: `vendor${i}/model`,
    }));
    const proc = {
      child: { exitCode: 0, signalCode: null },
      dispose: () => {
        disposed = true;
      },
      getState: async () => ({ isStreaming: false, isCompacting: false }),
      request: async ({ type }: { type: string }) =>
        type === 'get_commands'
          ? { success: true, data: { commands: [{ name: CONTEXT_COMMAND }] } }
          : { success: true, data: { entries } },
      prompt: async (text: string) => {
        expect(text.startsWith(`/${CONTEXT_COMMAND} `)).toBe(true);
        const input = JSON.parse(Buffer.from(text.split(' ')[1], 'base64').toString());
        expect(input.action).toBe('refresh');
        expect(input.includeDefaults).toBe(true);
        expect(input.model).toBeUndefined();
        entries.push({
          type: 'custom',
          customType: MODEL_DEFAULTS,
          data: { requestId: input.requestId, models, candidates: count ? candidates : undefined },
        });
      },
    };
    class Base {
      get sessions(): never {
        throw new Error('Profile refresh must not consult sessions');
      }
    }
    const Agent = enhancePiAgent(Base, {
      spawn: async (options: unknown) => {
        calls.push(options);
        return proc;
      },
    });
    const agent = new Agent();
    const result = await agent.extMethod('_pi_workbench/profile_models', { sessionId: '' });
    if (count) {
      expect(result).toMatchObject({
        models,
        candidates: candidates.slice(0, 500),
        candidateCount: count,
      });
      if (!('candidateSnapshot' in result)) throw new Error('Missing page snapshot');
      const params = { sessionId: '', snapshot: result.candidateSnapshot, cursor: 500 };
      expect(await agent.extMethod('_pi_workbench/model_candidates', params)).toEqual({
        models: candidates.slice(500),
      });
      await expect(
        agent.extMethod('_pi_workbench/model_candidates', { ...params, snapshot: 'stale' }),
      ).rejects.toThrow('cursor');
    } else {
      expect(result).toEqual({ models });
    }
    expect(calls).toEqual([expect.objectContaining({ workbenchMetadata: true })]);
    expect(calls[0]).not.toHaveProperty('sessionPath');
    expect(disposed).toBe(true);
  },
);
