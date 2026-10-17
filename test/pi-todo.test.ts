import { expect, it } from 'vitest';
import { branchTodos, installTodoBridge, TODO_WIDGET } from '../src/pi-todo';
import { todoWidgetPlan } from '../src/pi-todo-widget';

const tasks = [{ id: 1, subject: '实现功能', status: 'completed' }];
it('uses branch state entries over stale tool results and honors clear', () => {
  const state = { type: 'custom', customType: 'rpiv-todo-state', data: { tasks } };
  const stale = {
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', details: { tasks: [] } },
  };
  expect(branchTodos([state, stale])).toEqual(tasks);
  expect(branchTodos([state, { ...state, data: { tasks: [] } }])).toEqual([]);
  expect(branchTodos([stale])).toEqual([]);
  expect(branchTodos([])).toEqual([]);
});
it('maps RPC snapshots to plans, including empty plans and deleted tasks', () => {
  const event = {
    method: 'setWidget',
    widgetKey: TODO_WIDGET,
    widgetLines: [
      JSON.stringify({ tasks: [...tasks, { id: 2, subject: '删除', status: 'deleted' }] }),
    ],
  };
  expect(todoWidgetPlan(event)?.entries).toEqual([
    { content: '实现功能', status: 'completed', priority: 'medium' },
  ]);
  expect(todoWidgetPlan({ ...event, widgetLines: ['{"tasks":[]}'] })?.entries).toEqual([]);
  expect(todoWidgetPlan({ ...event, widgetLines: ['invalid'] })).toBeUndefined();
  expect(todoWidgetPlan({ ...event, widgetKey: 'other' })).toBeUndefined();
});
it('publishes branch-local snapshots in RPC only', () => {
  const handlers = new Map<string, Function>();
  installTodoBridge({
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  });
  const lines: string[][] = [];
  const ctx = {
    mode: 'rpc',
    sessionManager: {
      getBranch: () => [{ type: 'custom', customType: 'rpiv-todo-state', data: { tasks } }],
    },
    ui: { setWidget: (_key: string, value: string[]) => lines.push(value) },
  };
  handlers.get('session_start')!({}, ctx);
  expect(JSON.parse(lines[0][0]).tasks).toEqual(tasks);
  handlers.get('session_start')!({}, { ...ctx, mode: 'tui' });
  expect(lines).toHaveLength(1);
});
