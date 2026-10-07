// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createMessageRenderer } from '../webview/messages';
import { TranscriptView } from '../webview/transcript';
import type { Entry } from '../src/shared';
const summary: Entry = {
  id: 'changes',
  role: 'diff',
  text: 'summary',
  diff: {
    status: 'complete',
    warnings: ['净变化，不是回滚点'],
    files: [
      {
        path: '<img src=x>.ts',
        status: 'modified',
        before: 'before\n',
        after: 'after\n',
        added: 1,
        removed: 1,
        patch: '@@ -1 +1 @@\n-before\n+<script>unsafe</script>\n',
      },
    ],
  },
};
it('keeps the final turn diff visible after the answer and outside collapsed activity', () => {
  const root = document.createElement('div'),
    send = vi.fn(),
    render = createMessageRenderer(
      (text) => text,
      () => 'session',
      send,
    );
  const transcript = new TranscriptView(root, render);
  transcript.update(
    [
      { id: 'u', role: 'user', text: 'task' },
      { id: 'tool', role: 'tool', tool: { toolCallId: 't', title: 'edit' } },
      { id: 'a', role: 'assistant', text: 'answer' },
      summary,
    ],
    false,
  );
  expect(root.lastElementChild?.className).toContain('turn-diff');
  expect(root.querySelector('.activity-body .turn-diff')).toBeNull();
  expect(root.querySelector('.turn-diff-header strong')?.textContent).toContain('1 个文件 · +1 −1');
  (root.querySelector('.turn-diff-header button') as HTMLButtonElement).click();
  expect(send).toHaveBeenLastCalledWith({ type: 'diff', id: 'changes', index: -1 });
});
it('renders patches lazily as text and opens the saved before/after comparison', () => {
  const send = vi.fn(),
    node = createMessageRenderer(
      (text) => text,
      () => 'session',
      send,
    )(summary);
  expect(node.querySelector('pre')).toBeNull();
  expect(node.querySelector('img')).toBeNull();
  const group = node.querySelector<HTMLDetailsElement>('.turn-diff-files')!;
  expect(group.open).toBe(false);
  group.open = true;
  const file = group.querySelector<HTMLDetailsElement>('.turn-diff-file')!;
  file.open = true;
  file.dispatchEvent(new Event('toggle'));
  group.open = false;
  expect(group.open).toBe(false);
  expect(file.querySelector('script')).toBeNull();
  expect(file.querySelector('pre')?.textContent).toContain('<script>unsafe</script>');
  expect(file.querySelector('.diff-add')).not.toBeNull();
  expect(file.querySelector('.diff-remove')).not.toBeNull();
  file.querySelector('button')!.click();
  expect(send).toHaveBeenCalledWith({ type: 'diff', id: 'changes', index: 0 });
});
it('does not call unavailable or partial results a clean workspace', () => {
  const render = createMessageRenderer(
    (text) => text,
    () => undefined,
    () => {},
  );
  const unavailable = render({
    ...summary,
    diff: { status: 'unavailable', files: [], warnings: ['not a Git worktree'] },
  });
  expect(unavailable.textContent).toContain('未能采集');
  expect(unavailable.textContent).not.toContain('未检测到文件');
  const partial = render({
    ...summary,
    diff: { status: 'partial', files: [], warnings: ['files omitted'] },
  });
  expect(partial.textContent).toContain('已采集范围内');
});
it('shows empty results and scope notes without a disclosure', () => {
  const node = createMessageRenderer(
    (text) => text,
    () => undefined,
    () => {},
  )({ ...summary, diff: { status: 'complete', files: [], warnings: ['净变化，不是回滚点'] } });
  const notes = node.querySelector('.turn-diff-notes')!;
  expect(notes.tagName).toBe('DIV');
  expect(node.querySelector('details')).toBeNull();
  expect(notes.textContent).toContain('本轮未检测到文件净变化。');
  expect(notes.textContent).toContain('净变化，不是回滚点');
});
