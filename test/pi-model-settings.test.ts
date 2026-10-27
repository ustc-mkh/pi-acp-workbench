import { expect, it } from 'vitest';
import { enhancePiAgent } from '../src/pi-enhancements';
import { CONTEXT_APPLIED } from '../src/pi-context-mode';
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
        ? { success: true, data: { commands: [{ name: 'pi-acp-workbench-models' }] } }
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
  // Use the actual registered command name from the existing trusted Pi extension.
  const { CONTEXT_COMMAND } = await import('../src/pi-context-mode');
  proc.request = async (command: { type: string }) =>
    command.type === 'get_commands'
      ? { success: true, data: { commands: [{ name: CONTEXT_COMMAND }] } }
      : { success: true, data: { entries } };
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
