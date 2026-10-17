import type * as acp from '@agentclientprotocol/sdk';
import { TODO_WIDGET, todoTasks } from './pi-todo';

/** Convert our RPC-safe widget into a standard ACP plan, not assistant prose. */
export function todoWidgetPlan(
  ev: Record<string, unknown>,
): Extract<acp.SessionUpdate, { sessionUpdate: 'plan' }> | undefined {
  if (ev.method !== 'setWidget' || ev.widgetKey !== TODO_WIDGET) return;
  if (!Array.isArray(ev.widgetLines) || typeof ev.widgetLines[0] !== 'string') return;
  let tasks;
  try {
    tasks = todoTasks(JSON.parse(ev.widgetLines[0]));
  } catch {
    return;
  }
  if (!tasks) return;
  return {
    sessionUpdate: 'plan',
    entries: tasks
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({
        content: t.subject,
        status:
          t.status === 'completed'
            ? 'completed'
            : t.status === 'in_progress'
              ? 'in_progress'
              : 'pending',
        priority: 'medium',
      })),
  };
}
