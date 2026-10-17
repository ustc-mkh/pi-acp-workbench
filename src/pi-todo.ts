// rpiv-todo snapshots are branch-local; never import the package's global store.
export const TODO_WIDGET = 'pi-acp-workbench/rpiv-todo';
export interface TodoTask {
  id: number;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  activeForm?: string;
}
export function todoTasks(value: unknown): TodoTask[] | undefined {
  if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks))
    return;
  if (value.tasks.length > 10000) return;
  const tasks: TodoTask[] = [];
  for (const task of value.tasks) {
    if (
      !task ||
      !Number.isSafeInteger(task.id) ||
      typeof task.subject !== 'string' ||
      !['pending', 'in_progress', 'completed', 'deleted'].includes(task.status)
    )
      return;
    tasks.push({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(typeof task.activeForm === 'string' ? { activeForm: task.activeForm } : {}),
    });
  }
  return tasks;
}
export function normalizeTodoTasks(tasks: TodoTask[]): TodoTask[] {
  return tasks.filter((task) => task.status !== 'completed' && task.status !== 'deleted');
}
export function branchTodos(branch: Iterable<unknown>): TodoTask[] {
  let custom: TodoTask[] | undefined;
  let result: TodoTask[] | undefined;
  for (const entry of branch) {
    const e = entry as {
      type?: string;
      customType?: string;
      data?: unknown;
      message?: { role?: string; toolName?: string; details?: unknown };
    };
    if (e.type === 'custom' && e.customType === 'rpiv-todo-state')
      custom = todoTasks(e.data) ?? custom;
    if (e.type === 'message' && e.message?.role === 'toolResult' && e.message.toolName === 'todo')
      result = todoTasks(e.message.details) ?? result;
  }
  return custom ?? result ?? [];
}
interface TodoContext {
  mode?: string;
  sessionManager: { getBranch(): Iterable<unknown> };
  ui: { setWidget(key: string, lines: string[]): void };
}
export interface TodoExtensionApi {
  on(
    event: string,
    handler: (event: { toolName?: string; details?: unknown }, ctx: TodoContext) => void,
  ): void;
}
export function installTodoBridge(pi: TodoExtensionApi) {
  const publish = (ctx: TodoContext, tasks = branchTodos(ctx.sessionManager.getBranch())) => {
    if (ctx.mode === 'rpc')
      ctx.ui.setWidget(TODO_WIDGET, [JSON.stringify({ tasks: normalizeTodoTasks(tasks) })]);
  };
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_compact'])
    pi.on(event, (_, ctx) => publish(ctx));
  pi.on('message_end', (_, ctx) => publish(ctx));
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'todo') return;
    // A state-changing call already appended rpiv-todo-state, including nested calls.
    // For old package versions without state entries use the just-returned details.
    const branch = [...ctx.sessionManager.getBranch()];
    const tasks = branch.some(
      (e) => (e as { customType?: string }).customType === 'rpiv-todo-state',
    )
      ? branchTodos(branch)
      : todoTasks(event.details);
    if (tasks) publish(ctx, tasks);
  });
}
