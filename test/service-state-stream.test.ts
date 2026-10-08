import { expect, it } from 'vitest';
import { ServiceStateStream } from '../src/service-state-stream';
import type { ServiceStateEvent, ServiceStatePatch } from '../src/session-protocol';
const initial = (): ServiceStateEvent => ({
  type: 'state',
  revision: 1,
  snapshot: {
    id: 'one',
    cwd: '/work',
    title: 'one',
    updated: 1,
    entries: [
      { id: 'a', role: 'assistant', text: 'old' },
      { id: 'b', role: 'assistant', text: '中' },
    ],
  },
  busy: true,
  permissions: [],
  commands: [],
  plan: [],
});
const patch = (): ServiceStatePatch => ({
  type: 'statePatch',
  sessionId: 'one',
  baseRevision: 1,
  revision: 2,
  state: {
    snapshot: { id: 'one', cwd: '/work', title: 'one', updated: 1 },
    busy: false,
    permissions: [],
    commands: [],
    plan: [],
  },
  entries: [{ id: 'b', role: 'assistant', text: '中文😀' }],
});
it('preserves unchanged identities while applying changes, additions, removals and metadata replacement', () => {
  const stream = new ServiceStateStream();
  const first = stream.receive(initial());
  const second = stream.receive(patch());
  expect(second.snapshot.entries[0]).toBe(first.snapshot.entries[0]);
  expect(second.snapshot.entries[1]).toMatchObject({ text: '中文😀' });
  expect(second.busy).toBe(false);
  const next = stream.receive({
    ...patch(),
    baseRevision: 2,
    revision: 3,
    entries: [{ id: 'c', role: 'assistant', text: 'new' }],
    order: ['c', 'a'],
  });
  expect(next.snapshot.entries.map((e) => e.id)).toEqual(['c', 'a']);
  expect(next.snapshot.entries[1]).toBe(first.snapshot.entries[0]);
});
it('fails closed on missing baselines, version gaps and missing order entries', () => {
  const stream = new ServiceStateStream();
  expect(() => stream.receive(patch())).toThrow('版本');
  stream.receive(initial());
  expect(() => stream.receive({ ...patch(), baseRevision: 9 })).toThrow('版本');
  expect(() => stream.receive({ ...patch(), order: ['missing'] })).toThrow('顺序');
  expect(() =>
    stream.receive({ ...patch(), entries: [{ id: 'new', role: 'assistant', text: 'new' }] }),
  ).toThrow('缺少顺序');
});
it('resets baselines on unwatch/reconnect and accepts legacy full state events', () => {
  const stream = new ServiceStateStream();
  stream.receive(initial());
  stream.clear('one');
  expect(() => stream.receive(patch())).toThrow();
  const full = { ...initial(), revision: undefined };
  expect(stream.receive(full)).toBe(full);
  stream.receive(initial());
  stream.clear();
  expect(() => stream.receive(patch())).toThrow();
});
