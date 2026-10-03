// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { HistoryList } from '../webview/history';
import type { ChatState, UiMessage } from '../src/shared';
const history = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: `会话 ${i}`, cwd: '/project', updated: 100 - i }));
it('deletes the requested row without opening it and keeps older rows available', () => {
  const container = document.createElement('div'), messages: UiMessage[] = [];
  let opens = 0;
  const list = new HistoryList(container, message => messages.push(message), () => opens++);
  const state: Pick<ChatState, 'history' | 'status' | 'sessionId'> = { history, status: 'ready', sessionId: '0' };
  list.update(state);
  expect(container.children).toHaveLength(7);
  expect(container.firstElementChild?.lastElementChild?.className).toBe('history-delete');
  (container.querySelector('[data-id="3"] .history-delete') as HTMLButtonElement).click();
  expect(messages).toEqual([{ type: 'deleteHistory', id: '3' }]); expect(opens).toBe(0);
  list.update({ ...state, history: history.filter(item => item.id !== '3') });
  expect(container.querySelector('[data-id="3"]')).toBeNull(); expect(container.children).toHaveLength(6);
});
it('preserves row identity and scroll position during output and updates busy indicators', () => {
  const container = document.createElement('div');
  const list = new HistoryList(container, () => {}, () => {});
  const state: Pick<ChatState, 'history' | 'status' | 'sessionId'> = { history, status: 'busy', sessionId: '0' };
  list.update(state); const row = container.firstElementChild;
  container.scrollTop = 68;
  list.update(structuredClone(state));
  expect(container.firstElementChild).toBe(row); expect(container.scrollTop).toBe(68);
  expect(container.querySelectorAll('.running')).toHaveLength(1);
  expect(container.querySelector('.running')?.getAttribute('aria-label')).toBe('正在输出');
  expect(container.querySelector('.running')?.hasAttribute('data-tooltip')).toBe(false);
  expect((container.querySelector('.history-delete') as HTMLButtonElement).disabled).toBe(false);
  list.update({ ...state, status: 'ready' });
  expect(container.firstElementChild).toBe(row); expect(container.querySelectorAll('.running')).toHaveLength(0);
  expect(container.querySelectorAll('[aria-label="未在输出"]')).toHaveLength(7);
});
