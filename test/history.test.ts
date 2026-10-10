// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HistoryList } from '../webview/history';
import type { ChatState, UiMessage } from '../src/shared';
const history = Array.from({ length: 7 }, (_, i) => ({
  id: String(i),
  title: `会话 ${i}`,
  cwd: '/project',
  updated: 100 - i,
}));
it('deletes the requested row without opening it and keeps older rows available', () => {
  const container = document.createElement('div'),
    messages: UiMessage[] = [];
  const list = new HistoryList(container, (message) => messages.push(message));
  const state: Pick<ChatState, 'history' | 'status' | 'sessionId'> = {
    history,
    status: 'ready',
    sessionId: '0',
  };
  list.update(state);
  expect(container.children).toHaveLength(4);
  expect(container.firstElementChild?.lastElementChild?.className).toBe('history-delete');
  (container.querySelector('[data-id="3"] .history-delete') as HTMLButtonElement).click();
  expect(messages).toEqual([{ type: 'deleteHistory', id: '3' }]);
  list.update({ ...state, history: history.filter((item) => item.id !== '3') });
  expect(container.querySelector('[data-id="3"]')).toBeNull();
  expect(container.children).toHaveLength(4);
});
it('distinguishes identical titles with persistent numbers independently of row order', () => {
  const container = document.createElement('div');
  const list = new HistoryList(container, () => {});
  const items = [
    { id: 'parent', sessionNumber: 7, title: 'same', cwd: '/project', updated: 1 },
    { id: 'branch', sessionNumber: 8, title: 'same', cwd: '/project', updated: 2 },
  ];
  list.update({ history: items, status: 'ready' });
  expect([...container.querySelectorAll('.session-number')].map((n) => n.textContent)).toEqual([
    '#007',
    '#008',
  ]);
  expect(
    container.querySelector('[data-id=branch] .history-open')?.getAttribute('aria-label'),
  ).toBe('#008 same');
  list.update({ history: [...items].reverse(), status: 'ready' });
  expect(container.querySelector('[data-id=parent] .session-number')?.textContent).toBe('#007');
  expect(
    (container.querySelector('[data-id=branch] .history-open') as HTMLElement).dataset.tooltip,
  ).toBeUndefined();
  expect(container.querySelector('[data-tooltip]')).toBeNull();
});
it('preserves row identity and scroll position during output and updates busy indicators', () => {
  const container = document.createElement('div');
  const list = new HistoryList(container, () => {});
  const state: Pick<ChatState, 'history' | 'status' | 'sessionId'> = {
    history,
    status: 'busy',
    sessionId: '0',
  };
  list.update(state);
  const row = container.firstElementChild;
  container.scrollTop = 68;
  list.update(structuredClone(state));
  expect(container.firstElementChild).toBe(row);
  expect(container.scrollTop).toBe(68);
  expect(container.querySelectorAll('.running')).toHaveLength(1);
  expect(container.querySelector('.running')?.getAttribute('aria-label')).toBe('正在输出');
  expect(container.querySelector('.running')?.hasAttribute('data-tooltip')).toBe(false);
  expect((container.querySelector('.history-delete') as HTMLButtonElement).disabled).toBe(false);
  list.update({ ...state, status: 'ready' });
  expect(container.firstElementChild).toBe(row);
  expect(container.querySelectorAll('.running')).toHaveLength(0);
  expect(container.querySelectorAll('[aria-label="未在输出"]')).toHaveLength(4);
});
it('expands older sessions, preserves expansion during updates and selection, and collapses explicitly', () => {
  const parent = document.createElement('section'),
    container = document.createElement('div');
  parent.append(container);
  const messages: UiMessage[] = [],
    expanded: number[] = [];
  const list = new HistoryList(
    container,
    (message) => messages.push(message),
    false,
    (value) => expanded.push(value),
  );
  const state = { history, status: 'busy' as const, sessionId: '0' };
  list.update(state);
  const more = parent.querySelector<HTMLButtonElement>('.history-more')!;
  expect(more.getAttribute('aria-label')).toBe('展开至 10 条会话');
  more.click();
  expect(container.children).toHaveLength(7);
  const open = container.querySelector<HTMLButtonElement>('[data-id="6"] .history-open')!;
  expect(open.disabled).toBe(false);
  open.click();
  expect(messages).toEqual([{ type: 'resume', id: '6' }]);
  list.update({ ...state, status: 'ready' });
  expect(container.children).toHaveLength(7);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  parent.querySelector<HTMLButtonElement>('.history-less')!.click();
  expect(container.children).toHaveLength(4);
  expect(expanded).toEqual([10, 4]);
});
it('shows every busy session, including background sessions across harnesses', () => {
  const container = document.createElement('div');
  const list = new HistoryList(container, () => {});
  const items = history.slice(0, 3).map((s, i) => ({
    ...s,
    busy: i < 2,
    harness: i === 1 ? ('codex' as const) : ('pi' as const),
  }));
  list.update({ history: items, sessionId: '2', status: 'ready' });
  expect(container.querySelectorAll('.running')).toHaveLength(2);
  list.update({
    history: items.map((s) => ({ ...s, busy: false })),
    sessionId: '2',
    status: 'ready',
  });
  expect(container.querySelectorAll('.running')).toHaveLength(0);
});
it('steps 4 → 10 → 16 and back to closure, never renders more than 16', () => {
  const parent = document.createElement('section');
  const container = document.createElement('div');
  parent.append(container);
  let closed = 0;
  const limits: number[] = [];
  const list = new HistoryList(
    container,
    () => {},
    4,
    (n) => limits.push(n),
    () => closed++,
  );
  const state = {
    history: Array.from({ length: 25 }, (_, i) => ({ ...history[0], id: String(i) })),
    status: 'ready' as const,
  };
  list.update(state);
  const down = parent.querySelector<HTMLButtonElement>('.history-more')!;
  const up = parent.querySelector<HTMLButtonElement>('.history-less')!;
  expect(container.children).toHaveLength(4);
  down.click();
  expect(container.children).toHaveLength(10);
  down.click();
  expect(container.children).toHaveLength(16);
  expect(down.disabled).toBe(true);
  down.click();
  list.update(state);
  expect(container.children).toHaveLength(16);
  up.click();
  expect(container.children).toHaveLength(10);
  up.click();
  expect(container.children).toHaveLength(4);
  up.click();
  expect(closed).toBe(1);
  expect(limits).toEqual([10, 16, 10, 4]);
});
it('migrates a saved 20-row tier to 16 and uses shaftless chevrons', () => {
  const parent = document.createElement('section');
  const container = document.createElement('div');
  parent.append(container);
  const list = new HistoryList(container, () => {}, 20);
  list.update({
    history: Array.from({ length: 25 }, (_, i) => ({ ...history[0], id: String(i) })),
    status: 'ready',
  });
  expect(container.children).toHaveLength(16);
  const down = parent.querySelector<HTMLButtonElement>('.history-more')!;
  expect(down.disabled).toBe(true);
  expect(down.getAttribute('aria-label')).toBe('最多显示 16 条会话');
  expect(parent.querySelector('.history-less path')?.getAttribute('d')).toBe('M4 10l4-4 4 4');
  expect(down.querySelector('path')?.getAttribute('d')).toBe('M4 6l4 4 4-4');
});
