import { expect, it, vi } from 'vitest';
import { ConversationHistory } from '../src/conversation-history';
import { ConversationStatistics } from '../src/conversation-statistics';
import { ClientOperations } from '../src/conversation-history';
import { initialState } from '../src/state';
import type { Agent } from '../src/remote-agent';
import type { Snapshot } from '../src/shared';
const storage = () => {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  };
};
it('does not republish a remote list after history is disabled during initialization', async () => {
  let release!: (items: Snapshot[]) => void;
  const gate = new Promise<Snapshot[]>((resolve) => {
    release = resolve;
  });
  const state = initialState();
  let enabled = true;
  const history = new ConversationHistory({
    storage: storage(),
    enabled: () => enabled,
    current: () => state,
    changed: () => {},
    error: () => {},
    remote: { list: () => gate, remove: async () => {} },
  });
  history.start();
  await Promise.resolve();
  enabled = false;
  await history.disable(async () => {});
  release([
    {
      id: 'remote',
      harness: 'pi',
      title: 'hidden',
      cwd: '/work',
      updated: 1,
      entries: [],
      contextComplete: true,
    },
  ]);
  await history.ready;
  expect(history.items).toEqual([]);
  history.dispose();
});
it('retains history on failed deletion and discards a poll started before a successful deletion', async () => {
  const state = { ...initialState(), sessionId: 'one' };
  const item: Snapshot = {
    id: 'one',
    harness: 'pi',
    title: 'one',
    cwd: '/work',
    updated: 1,
    entries: [],
    contextComplete: true,
  };
  const list = vi.fn().mockResolvedValue([item]);
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk error'))
    .mockResolvedValue(undefined);
  const history = new ConversationHistory({
    storage: storage(),
    enabled: () => true,
    current: () => state,
    changed: () => {},
    error: () => {},
    remote: { list, remove },
  });
  history.start();
  await history.ready;
  await expect(history.remove('one', async () => {})).rejects.toThrow('disk error');
  expect(history.items).toEqual([item]);
  let release!: (items: Snapshot[]) => void;
  list.mockImplementationOnce(
    () =>
      new Promise<Snapshot[]>((resolve) => {
        release = resolve;
      }),
  );
  const poll = history.refresh();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  await history.remove('one', async () => {});
  release([item]);
  await poll;
  expect(history.items).toEqual([]);
  expect(history.forgotten.has('one')).toBe(true);
  history.dispose();
});
it('statistics coalesces paginated inspection and attributes usage to the conversation', async () => {
  const state = {
    ...initialState(),
    sessionId: 'native',
    status: 'ready' as const,
    entries: [{ id: 'u', role: 'user' as const, text: 'title' }],
  };
  const record = {
    id: 'call',
    sessionId: 'native',
    model: 'model',
    timestamp: Date.now(),
    kind: 'inference',
    input: 2,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ records: [record], cursor: 1, contextWindow: 1000 })
    .mockResolvedValueOnce({ records: [record] });
  const agent: Pick<Agent, 'harness' | 'info' | 'request'> = {
    harness: 'pi',
    info: { protocolVersion: 1, agentCapabilities: { _meta: { 'pi-workbench': { version: 1 } } } },
    request,
  } satisfies Pick<Agent, 'harness' | 'info' | 'request'>;
  const store = storage(),
    window = vi.fn(),
    stats = new ConversationStatistics(
      store,
      new ClientOperations(),
      () => ({ state, agent, harness: 'pi', conversationId: 'conversation', retained: true }),
      window,
      () => {},
    );
  await Promise.all([stats.refresh(), stats.refresh()]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(window).toHaveBeenCalledWith(1000);
  expect(stats.value.records).toEqual([{ ...record, sessionId: 'conversation' }]);
  expect(stats.value.titles).toEqual({ conversation: 'title' });
  stats.forget();
  await stats.persistTitles();
  expect(store.get('usageTitles')).toEqual({});
  expect(stats.value.records).toHaveLength(1);
});
it('statistics discards late responses and errors from detached sessions', async () => {
  let state = { ...initialState(), sessionId: 'old', status: 'ready' as const },
    reject!: (error: Error) => void;
  const agent: Pick<Agent, 'harness' | 'info' | 'request'> = {
    harness: 'pi',
    info: { protocolVersion: 1, agentCapabilities: { _meta: { 'pi-workbench': { version: 1 } } } },
    request: () =>
      new Promise<never>((_, fail) => {
        reject = fail;
      }),
  } satisfies Pick<Agent, 'harness' | 'info' | 'request'>;
  const stats = new ConversationStatistics(
    storage(),
    new ClientOperations(),
    () => ({ state, agent, harness: 'pi', retained: true }),
    () => {},
    () => {},
  );
  const pending = stats.refresh();
  state = { ...state, sessionId: 'new' };
  stats.reset('pi');
  reject(new Error('old failure'));
  await pending;
  expect(stats.value.note).toBeUndefined();
  expect(stats.pending).toBeUndefined();
  expect(stats.value.records).toEqual([]);
});
it('coalesces slow history polls, preserves the index, and only reports a continuing outage once', async () => {
  vi.useFakeTimers();
  const state = initialState(),
    error = vi.fn();
  const item: Snapshot = {
    id: 'one',
    harness: 'pi',
    title: 'one',
    cwd: '/work',
    updated: 1,
    entries: [],
    contextComplete: true,
  };
  const list = vi.fn().mockResolvedValue([item]);
  const history = new ConversationHistory({
    storage: storage(),
    enabled: () => true,
    current: () => state,
    changed: () => {},
    error,
    remote: { list, remove: async () => {} },
  });
  try {
    history.start();
    await history.ready;
    let reject!: (error: Error) => void;
    list.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(35000);
    expect(list).toHaveBeenCalledTimes(2); // Initial read plus just one slow refresh.
    const failure = new Error('list timeout');
    reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(history.items).toEqual([item]);
    list.mockRejectedValue(failure);
    await vi.advanceTimersByTimeAsync(15000);
    expect(error).toHaveBeenCalledTimes(1); // Dismissing this banner will not bring it back each poll.
    await expect(history.refresh()).rejects.toThrow('list timeout'); // Explicit refresh still fails visibly.
    list.mockResolvedValue([item]);
    await vi.advanceTimersByTimeAsync(5000);
    list.mockRejectedValue(failure);
    await vi.advanceTimersByTimeAsync(5000);
    expect(error).toHaveBeenCalledTimes(2); // A new outage after recovery is reported.
  } finally {
    history.dispose();
    vi.useRealTimers();
  }
});
it('discards a failed poll after disposal', async () => {
  const error = vi.fn();
  let reject!: (error: Error) => void;
  const history = new ConversationHistory({
    storage: storage(),
    enabled: () => true,
    current: initialState,
    changed: () => {},
    error,
    remote: {
      list: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
      remove: async () => {},
    },
  });
  history.start();
  await Promise.resolve();
  await Promise.resolve();
  history.dispose();
  reject(new Error('late timeout'));
  await history.ready;
  expect(error).not.toHaveBeenCalled();
});

it.each(['codex', 'claude'] as const)(
  'reads %s service usage without Pi capabilities and preserves coverage notes',
  async (harness) => {
    const state = {
      ...initialState(),
      sessionId: `workbench:${harness}:one`,
      status: 'ready' as const,
    };
    const record = {
      id: `acp:${harness}:one`,
      sessionId: state.sessionId,
      model: 'model',
      timestamp: 1,
      kind: 'acp-turn',
      input: 5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
    };
    const request = vi
      .fn()
      .mockResolvedValue({ records: [record], contextWindow: 200000, note: '仅包含上报的轮次' });
    const agent: Pick<Agent, 'harness' | 'info' | 'request'> = {
      harness,
      info: {
        protocolVersion: 1,
        agentCapabilities: { _meta: { 'session-service': { version: 3, usageInspection: true } } },
      },
      request,
    } satisfies Pick<Agent, 'harness' | 'info' | 'request'>;
    const window = vi.fn();
    const stats = new ConversationStatistics(
      storage(),
      new ClientOperations(),
      () => ({ state, agent, harness, retained: true }),
      window,
      () => {},
    );
    await stats.refresh();
    await stats.refresh();
    expect(stats.value.available).toBe(true);
    expect(stats.value.records).toEqual([record]);
    expect(stats.value.note).toBe('仅包含上报的轮次');
    expect(window).toHaveBeenCalledWith(200000);
    agent.info!.agentCapabilities!._meta = {};
    request.mockClear();
    await stats.refresh();
    expect(stats.value.available).toBe(false);
    expect(request).not.toHaveBeenCalled();
  },
);
