import { expect, it, vi } from 'vitest';
import { ActiveConversation } from '../src/active-conversation';
import { TurnCoordinator, type TurnHost } from '../src/conversation-turn';
import { ConversationLifecycle } from '../src/conversation-lifecycle';
import type { Agent } from '../src/remote-agent';

const config = {
  id: 'model',
  name: 'Model',
  type: 'select' as const,
  currentValue: 'a',
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
};
function fixture() {
  const active = new ActiveConversation();
  active.state.sessionId = 'one';
  active.state.status = 'ready';
  active.state.configs = [config];
  active.state.modes = {
    currentModeId: 'a',
    availableModes: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
  };
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const response = new Promise((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  const sync = vi.fn(async () => undefined);
  const agent = {
    request: vi.fn(() => response),
    withTimeout: <T>(promise: Promise<T>) => promise,
    sync,
    isClosed: false,
    dispose: () => {},
  } as unknown as Agent;
  active.replace({ agent });
  const host: TurnHost = {
    get state() {
      return active.state;
    },
    get agent() {
      return active.agent;
    },
    get generation() {
      return active.generation;
    },
    lifecycle: new ConversationLifecycle(),
    harness: 'pi',
    stopping: false,
    emit: vi.fn(),
    refreshHistory: vi.fn(async () => {}),
    refreshTelemetry: vi.fn(async () => {}),
  };
  return { active, host, coordinator: new TurnCoordinator(host), resolve, reject, sync };
}

it.each(['config', 'mode'] as const)(
  'keeps authoritative busy/settings when a %s RPC completes',
  async (type) => {
    const { host, coordinator, resolve, sync } = fixture();
    const pending =
      type === 'config'
        ? coordinator.onConfig({ type: 'config', id: 'model', value: 'b' })
        : coordinator.onMode({ type: 'mode', value: 'b' });
    expect(host.state.status).toBe('connecting');
    // Another client has started work and published a newer catalogue/mode.
    host.state.status = 'busy';
    host.state.configs = [{ ...config, currentValue: 'newer' }];
    host.state.modes!.currentModeId = 'newer';
    resolve({ configOptions: [{ ...config, currentValue: 'b' }] });
    await pending;
    expect(sync).toHaveBeenCalledOnce();
    expect(host.state.status).toBe('busy');
    expect(host.state.configs[0].currentValue).toBe('newer');
    expect(host.state.modes!.currentModeId).toBe('newer');
  },
);

it('synchronizes on failure without masking the original RPC error', async () => {
  const { host, coordinator, reject, sync } = fixture();
  const pending = coordinator.onConfig({ type: 'config', id: 'model', value: 'b' });
  const failed = expect(pending).rejects.toThrow('config rejected');
  host.state.status = 'busy';
  sync.mockRejectedValueOnce(new Error('sync failed'));
  reject(new Error('config rejected'));
  await failed;
  expect(host.state.status).toBe('busy');
});

it('does not leave the UI connecting when authoritative synchronization fails', async () => {
  const { host, coordinator, resolve, sync } = fixture();
  sync.mockRejectedValueOnce(new Error('session was deleted'));
  const pending = coordinator.onConfig({ type: 'config', id: 'model', value: 'b' });
  const failed = expect(pending).rejects.toThrow('session was deleted');
  resolve({ configOptions: [config] });
  await failed;
  expect(host.state.status).toBe('disconnected');
});

it('does not touch a replacement session after a late settings response', async () => {
  const { active, coordinator, resolve, sync } = fixture();
  const pending = coordinator.onConfig({ type: 'config', id: 'model', value: 'b' });
  active.reset({
    sessionId: 'two',
    status: 'busy',
    configs: [{ ...config, currentValue: 'newer' }],
  });
  resolve({ configOptions: [config] });
  await pending;
  expect(sync).not.toHaveBeenCalled();
  expect(active.state.status).toBe('busy');
  expect(active.state.configs?.[0].currentValue).toBe('newer');
});
