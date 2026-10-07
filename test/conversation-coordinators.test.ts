import { expect, it, vi } from 'vitest';
import { ConversationHistory } from '../src/conversation-history';
import { ConversationStatistics } from '../src/conversation-statistics';
import { HistoryPersistence } from '../src/history-persistence';
import { SnapshotStore } from '../src/snapshots';
import { initialState } from '../src/state';
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
    leaseLost: () => {},
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
it('keeps deletion ordered behind pending writes without resurrecting the deleted index', async () => {
  const state = { ...initialState(), sessionId: 'one' },
    history = new ConversationHistory({
      storage: storage(),
      enabled: () => true,
      current: () => state,
      changed: () => {},
      error: () => {},
      leaseLost: () => {},
    });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = history.snapshots.write.bind(history.snapshots);
  vi.spyOn(history.snapshots, 'write').mockImplementationOnce(async (snapshot) => {
    await gate;
    return original(snapshot);
  });
  const save = history.save({
    id: 'one',
    harness: 'pi',
    title: 'one',
    cwd: '/work',
    updated: 1,
    entries: [],
    contextComplete: true,
  });
  await vi.waitFor(() => expect(history.snapshots.write).toHaveBeenCalled());
  const remove = history.remove(undefined, async () => {});
  release();
  await Promise.all([save, remove]);
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
  const agent: any = {
    harness: 'pi',
    info: { agentCapabilities: { _meta: { 'pi-workbench': { version: 1 } } } },
    request,
  };
  const store = storage(),
    window = vi.fn(),
    stats = new ConversationStatistics(
      store,
      new HistoryPersistence(new SnapshotStore(), false),
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
  const agent: any = {
    harness: 'pi',
    info: { agentCapabilities: { _meta: { 'pi-workbench': { version: 1 } } } },
    request: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  };
  const stats = new ConversationStatistics(
    storage(),
    new HistoryPersistence(new SnapshotStore(), false),
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
    leaseLost: () => {},
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
    leaseLost: () => {},
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
