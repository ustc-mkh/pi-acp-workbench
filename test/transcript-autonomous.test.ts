// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { Entry } from '../src/shared';
import { transcriptBlocks, TranscriptView } from '../webview/transcript';

const prior: Entry[] = [
  { id: 'u', role: 'user', text: 'task' },
  { id: 't', role: 'thought', text: 'thinking', turnId: 'foreground' },
  { id: 'a', role: 'assistant', text: 'original answer', turnId: 'foreground' },
  {
    id: 'd',
    role: 'diff',
    text: '本轮修改',
    diff: { status: 'complete', files: [], warnings: [] },
  },
];
const wake: Entry[] = [
  { id: 'n', role: 'notice', text: 'background done', turnId: 'background-1' },
  { id: 't2', role: 'thought', text: 'new thinking', turnId: 'background-1' },
  { id: 'a2', role: 'assistant', text: 'new answer', turnId: 'background-1' },
];
it('does not reopen a settled trace when a wake starts before its first output', () => {
  expect(transcriptBlocks(prior, true, 'background-1')).toEqual(transcriptBlocks(prior, false));
  const root = document.createElement('div');
  const view = new TranscriptView(root, () => document.createElement('article'));
  view.update(prior, true, 'background-1');
  expect(root.querySelector('.running')).toBeNull();
  expect(root.querySelector('.running-turn')).toBeNull();
});
it('preserves settled answers and diffs as top-level messages across independent wakes', () => {
  for (const busy of [true, false]) {
    const blocks = transcriptBlocks([...prior, ...wake], busy);
    expect(blocks).toContainEqual({ kind: 'message', entry: prior[2] });
    expect(blocks).toContainEqual({ kind: 'message', entry: prior[3] });
    expect(blocks).toContainEqual({ kind: 'message', entry: wake[2] });
    expect(blocks[1]).toMatchObject({ kind: 'activity', entries: [prior[1]], running: false });
    expect(blocks.filter((b) => b.kind === 'activity').at(-1)).toMatchObject({ running: busy });
  }
  const next: Entry = { id: 'a3', role: 'assistant', text: 'second wake', turnId: 'background-2' };
  const restored = transcriptBlocks(JSON.parse(JSON.stringify([...prior, ...wake, next])));
  expect(restored).toContainEqual({ kind: 'message', entry: wake[2] });
  expect(restored).toContainEqual({ kind: 'message', entry: next });
});
it('retains settled DOM and action visibility while only the latest run becomes live', () => {
  const root = document.createElement('div');
  const view = new TranscriptView(root, (entry) => {
    const node = document.createElement('article');
    node.dataset.id = entry.id;
    node.innerHTML = '<div class="message-actions">复制 / 分支</div>';
    return node;
  });
  view.update(prior, false);
  const answer = root.querySelector('[data-id=a]');
  const diff = root.querySelector('[data-id=d]');
  view.update([...prior, ...wake], true);
  expect(root.querySelector(':scope > [data-id=a]')).toBe(answer);
  expect(root.querySelector(':scope > [data-id=d]')).toBe(diff);
  expect(answer?.classList.contains('running-turn')).toBe(false);
  expect(root.querySelector('[data-id=a2]')?.classList.contains('running-turn')).toBe(true);
  expect(root.querySelector('details')?.classList.contains('running')).toBe(false);
  view.update([...prior, ...wake], false);
  expect(root.querySelector(':scope > [data-id=a]')).toBe(answer);
  expect(root.querySelector(':scope > [data-id=d]')).toBe(diff);
  expect(root.querySelector(':scope > [data-id=a2]')).not.toBeNull();
});
it('starts a boundary when a new tagged run follows legacy untagged entries', () => {
  const legacy = prior.map(({ turnId: _, ...entry }) => entry as Entry);
  expect(transcriptBlocks([...legacy, ...wake])).toContainEqual({
    kind: 'message',
    entry: legacy[2],
  });
});
