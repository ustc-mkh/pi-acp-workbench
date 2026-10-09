// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { TranscriptView, transcriptBlocks } from '../webview/transcript';
import type { Entry } from '../src/shared';
const user: Entry = { id: 'u', role: 'user', text: 'task' };
const thought: Entry = { id: 't', role: 'thought', text: 'thinking' };
const tool: Entry = {
  id: 'tool',
  role: 'tool',
  tool: { toolCallId: 'call', title: 'read', status: 'completed' },
};
const answer: Entry = { id: 'a', role: 'assistant', text: 'answer' };
it('groups a whole execution trace, preserving the user request and final answer', () => {
  const entries: Entry[] = [
    user,
    thought,
    { id: 'n', role: 'assistant', text: 'next step' },
    tool,
    answer,
  ];
  const blocks = transcriptBlocks(entries);
  expect(blocks.map((b) => b.kind)).toEqual(['message', 'activity', 'message']);
  expect(blocks[1]).toMatchObject({ entries: [thought, entries[2], tool] });
  expect(
    transcriptBlocks([...entries, { ...user, id: 'u2' }, { ...tool, id: 'tool2' }]),
  ).toHaveLength(5);
});
it('keeps groups folded by default, preserves toggles while streaming, and supports fold-all', () => {
  const root = document.createElement('div');
  const view = new TranscriptView(root, (entry) => {
    const node = document.createElement('article');
    node.textContent = entry.id;
    return node;
  });
  view.update([user, thought, tool, answer], false);
  const group = root.querySelector('details')!;
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')!.textContent).toContain('1 次工具调用');
  group.open = true;
  view.update([user, { ...thought, text: 'more thinking' }, tool, answer], true);
  expect(root.querySelector('details')).toBe(group);
  expect(group.open).toBe(true);
  expect(root.lastElementChild!.textContent).toBe('a');
  view.setExpanded(false);
  expect(group.open).toBe(false);
  view.setExpanded(true);
  expect(group.open).toBe(true);
  view.update([user, answer], false);
  expect(root.querySelector('details')).toBeNull();
});
it('keeps live narration visible between folded runs of tools and thoughts, then folds the whole turn', () => {
  const root = document.createElement('div');
  const view = new TranscriptView(root, (entry) => {
    const node = document.createElement('article');
    node.dataset.id = entry.id;
    return node;
  });
  view.update([user, thought, answer], true);
  const existing = root.querySelector('[data-id=a]');
  view.update([user, thought, answer, tool], true);
  expect(root.querySelector(':scope > [data-id=a]')).toBe(existing);
  expect(root.querySelectorAll(':scope > details')).toHaveLength(2);
  expect([...root.querySelectorAll('details')].every((node) => !node.open)).toBe(true);
  const final: Entry = { ...answer, id: 'final', text: 'finished' };
  view.update([user, thought, answer, tool, final], false);
  expect(root.querySelectorAll(':scope > details')).toHaveLength(1);
  expect(root.querySelector('.activity-body [data-id=a]')).toBe(existing);
  expect(root.querySelector('details')!.open).toBe(false);
  expect(root.lastElementChild?.getAttribute('data-id')).toBe('final');
});
it('folds narration without tools at completion and only streams the latest turn', () => {
  const narration: Entry = { ...answer, id: 'n', text: 'next step' };
  expect(transcriptBlocks([user, narration, answer], true).map((block) => block.kind)).toEqual([
    'message',
    'message',
    'message',
  ]);
  expect(transcriptBlocks([user, narration, answer]).map((block) => block.kind)).toEqual([
    'message',
    'activity',
    'message',
  ]);
  const blocks = transcriptBlocks(
    [
      user,
      thought,
      narration,
      tool,
      answer,
      { ...user, id: 'u2' },
      { ...thought, id: 't2' },
      { ...answer, id: 'a2' },
    ],
    true,
  );
  expect(blocks[1]).toMatchObject({ kind: 'activity', entries: [thought, narration, tool] });
  expect(blocks.at(-1)).toMatchObject({ kind: 'message', entry: { id: 'a2' } });
});
it('automatically folds a finished turn even after expanding activity while it was running', () => {
  const root = document.createElement('div');
  const view = new TranscriptView(root, () => document.createElement('article'), true);
  const narration: Entry = { ...answer, id: 'n' };
  view.update([user, narration, thought, tool, answer], true);
  view.update([user, narration, thought, tool, answer], false);
  const group = root.querySelector('details')!;
  expect(group.open).toBe(false);
  group.open = true;
  view.update([user, narration, thought, tool, answer], false);
  expect(group.open).toBe(true);
});
it('folds progress notices while retaining the final answer even when trailing tools arrive', () => {
  const notice: Entry = { id: 'notice', role: 'notice', text: 'progress' };
  const blocks = transcriptBlocks([user, thought, notice, answer, tool]);
  expect(blocks.map((block) => block.kind)).toEqual(['message', 'activity', 'message']);
  expect(blocks[1]).toMatchObject({ entries: [thought, notice, tool] });
  expect(blocks[2]).toMatchObject({ entry: answer });
});
