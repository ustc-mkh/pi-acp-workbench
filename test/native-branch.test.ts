import { expect, it, vi } from 'vitest';
import { enhancePiAgent } from '../src/pi-enhancements';
import type { PiState } from '../src/pi-rpc-types';
import {
  nativePath,
  nativeForkPoints,
  nativePrefixHash,
  type NativeEntry,
} from '../src/native-branch';
function chain(items: Partial<NativeEntry>[]): NativeEntry[] {
  return items.map((e, i) => ({
    type: 'message',
    id: String(i),
    parentId: i ? String(i - 1) : null,
    ...e,
  }));
}
const msg = (role: string, text: string, timestamp = 1) => ({
  message: { role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' },
});
it('reserves native preparation immediately and honors cancellation before worker startup', async () => {
  let ready!: (value: PiState) => void;
  const state = new Promise<PiState>((resolve) => {
      ready = resolve;
    }),
    spawn = vi.fn();
  class Base {
    sessions = new Map([['s', { sessionId: 's', proc: { getState: () => state } }]]);
  }
  const Enhanced = enhancePiAgent(Base, { spawn }),
    agent = new Enhanced();
  const first = agent.extMethod('_pi_workbench/fork', { sessionId: 's' });
  await expect(agent.extMethod('_pi_workbench/fork', { sessionId: 's' })).rejects.toThrow(
    'already in progress',
  );
  await agent.extMethod('_pi_workbench/cancel_fork', { sessionId: 's' });
  ready({ sessionFile: 'not-opened' });
  await expect(first).rejects.toThrow('已取消');
  expect(spawn).not.toHaveBeenCalled();
});
it('selects the active native path and rejects broken or cyclic parents', () => {
  const entries = chain([
    msg('user', 'a'),
    msg('assistant', 'b'),
    { ...msg('user', 'abandoned'), parentId: '0' },
  ]);
  expect(nativePath(entries, '1').map((e) => e.id)).toEqual(['0', '1']);
  expect(() => nativePath(entries, 'missing')).toThrow('不完整');
  expect(() => nativePath([{ ...entries[0], parentId: '0' }], '0')).toThrow('不完整');
});
it('hashes the exact prefix at a historical point, preserving prior but not later compactions', () => {
  const entries = chain([
    msg('user', 'before'),
    msg('assistant', 'answer'),
    { type: 'compaction', summary: 'native summary', firstKeptEntryId: '1', tokensBefore: 100 },
    msg('user', 'after'),
    msg('assistant', 'latest'),
  ]);
  const points = nativeForkPoints(entries);
  expect(points.find((p) => p.entryId === '1')!.hash).toBe(nativePrefixHash(entries.slice(0, 2)));
  expect(points.at(-1)!.hash).toBe(nativePrefixHash(entries));
  entries[2].summary = 'changed summary';
  const changed = nativeForkPoints(entries);
  expect(changed.find((p) => p.entryId === '1')!.hash).toBe(
    points.find((p) => p.entryId === '1')!.hash,
  );
  expect(changed.at(-1)!.hash).not.toBe(points.at(-1)!.hash);
});
it('rejects cuts with pending or orphaned tool results, and accepts a completed turn', () => {
  const entries = chain([
    msg('user', 'task'),
    {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'toolCall', id: 't1' },
          { type: 'toolCall', id: 't2' },
        ],
      },
    },
    { message: { role: 'toolResult', toolCallId: 't1', content: [] } },
    msg('assistant', 'partial'),
    { message: { role: 'toolResult', toolCallId: 't2', content: [] } },
    msg('assistant', 'done'),
  ]);
  expect(nativeForkPoints(entries).map((p) => p.safe)).toEqual([true, false, false, true]);
  const orphan = chain([
    { message: { role: 'toolResult', toolCallId: 'unknown', content: [] } },
    msg('assistant', 'not safe'),
  ]);
  expect(nativeForkPoints(orphan)[0].safe).toBe(false);
});
it('honors omitted attempts and excludes error responses as branch targets', () => {
  const entries = chain([
    {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'bad' }],
        stopReason: 'error',
      },
    },
    { type: 'context_edit', targetId: '0', replacement: null },
    msg('user', 'retry'),
    msg('assistant', 'ok'),
  ]);
  expect(nativeForkPoints(entries).map((p) => p.safe)).toEqual([false, true, true]);
});
it('preserves distinct native nodes for equal text and equal timestamps without display-row binding', () => {
  const points = nativeForkPoints(
    chain([msg('assistant', 'same', 10), msg('assistant', 'same', 10)]),
  );
  expect(points.map((point) => point.entryId)).toEqual(['0', '1']);
  expect(points[0].key).toBe(points[1].key);
  expect(points[0].timestamp).toBe(points[1].timestamp);
  expect(points[0].hash).not.toBe(points[1].hash);
});
it('allows native label re-chaining without changing the context fingerprint', () => {
  const entries = chain([
    msg('user', 'a'),
    { type: 'label', targetId: '0', label: 'bookmark' },
    msg('assistant', 'b'),
    { type: 'compaction', firstKeptEntryId: '1', summary: 'summary' },
    msg('assistant', 'c'),
  ]);
  const copied = entries
    .filter((e) => e.type !== 'label')
    .map((e, i, a) => ({
      ...e,
      parentId: i ? a[i - 1].id : null,
      ...(e.type === 'compaction' ? { firstKeptEntryId: '2' } : {}),
    }));
  expect(nativePrefixHash(entries)).toBe(nativePrefixHash(copied));
});
