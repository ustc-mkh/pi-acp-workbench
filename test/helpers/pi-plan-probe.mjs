// Test-owned provider extension: exercise the real branch-local Todo -> Plan bridge.
export default function (pi) {
  let calls = 0;
  pi.registerTool({
    name: 'todo',
    label: 'P6 Todo',
    description:
      'P6 acceptance only: on first call create two active branch-local tasks plus one completed task; on second call complete all tasks.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      calls++;
      const tasks =
        calls === 1
          ? [
              { id: 1, subject: 'P6_PENDING_TASK', status: 'pending' },
              { id: 2, subject: 'P6_ACTIVE_TASK', status: 'in_progress' },
              { id: 3, subject: 'P6_FINISHED_TASK', status: 'completed' },
            ]
          : [
              { id: 1, subject: 'P6_PENDING_TASK', status: 'completed' },
              { id: 2, subject: 'P6_ACTIVE_TASK', status: 'completed' },
            ];
      pi.appendEntry('rpiv-todo-state', { tasks });
      return { content: [{ type: 'text', text: 'P6_TODO_APPLIED' }], details: { tasks } };
    },
  });
}
