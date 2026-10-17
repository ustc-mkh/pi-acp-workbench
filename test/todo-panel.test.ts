// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { TodoPanel } from '../webview/todo-panel';
it('hides empty lists, renders status circles and preserves collapse on updates', () => {
  const host = document.createElement('section');
  const panel = new TodoPanel(host);
  panel.update([], 'one');
  expect(host.hidden).toBe(true);
  const entries = Array.from({ length: 7 }, (_, i) => ({
    content: `任务 ${i}`,
    status: i === 0 ? ('completed' as const) : ('pending' as const),
    priority: 'medium' as const,
  }));
  panel.update(entries, 'one');
  expect(host.hidden).toBe(false);
  expect(host.querySelectorAll('li')).toHaveLength(7);
  expect(host.querySelector('.todo-circle')?.textContent).toBe('✓');
  expect(host.querySelector('summary')?.textContent).toContain('1/7');
  const details = host.querySelector('details')!;
  details.open = false;
  panel.update(entries.slice(1), 'one');
  expect(details.open).toBe(false);
  panel.update([], 'two');
  expect(host.hidden).toBe(true);
});
