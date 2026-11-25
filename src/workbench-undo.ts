import type { WorkbenchClient } from './workbench-client';
import type { WorkbenchPorts } from './workbench-controller';
import type { WorkbenchOperations } from './workbench-operations';
import type { ClientCommand } from './workbench-protocol';
import type { WorkbenchSession } from './workbench-session';

export class WorkbenchUndo {
  confirming = false;
  constructor(
    private client: WorkbenchClient,
    private ports: Pick<WorkbenchPorts, 'confirmUndo' | 'hasDirtyDocuments' | 'authorize' | 'post'>,
    private receipts: WorkbenchOperations,
  ) {}

  async execute(
    command: Extract<ClientCommand, { method: 'undo_turn' }>,
    selected: WorkbenchSession,
    checkSession: () => void,
  ) {
    const { session, turn, files } = command;
    const check = () => {
      checkSession();
      const view = selected.view.view;
      if (selected.view.status !== 'ready' || !view || view.active_turn)
        throw new Error('Wait for the active task to finish before undo');
      return view.cwd;
    };
    const cwd = check();
    const checkEditors = async () => {
      check();
      if (await this.ports.hasDirtyDocuments?.(cwd))
        throw new Error('Save or close dirty editor buffers before undo');
    };
    if (!selected.view.entries.some((row) => row.turn === turn))
      throw new Error('Turn is not in confirmed history');
    if (this.confirming) throw new Error('Finish or cancel the undo confirmation first');
    this.confirming = true;
    try {
      const preflight = await this.client.call({ method: 'validate_undo', session, turn, files });
      const conflicts = preflight.files.filter((file) => file.status !== 'ready');
      if (conflicts.length) {
        throw new Error(
          '撤回预检失败。请检查以下文件后重新选择。\n' +
            conflicts.map((file) => file.path + ' · ' + (file.error || file.status)).join('\n'),
        );
      }
      await checkEditors();
      if (!(await this.ports.confirmUndo?.(session, turn, files ?? undefined))) return;
      await checkEditors();
      await this.ports.authorize(cwd);
      check();
    } finally {
      this.confirming = false;
    }
    const result = await this.receipts.execute(command);
    if ('UndoCompleted' in result)
      this.ports.post({ type: 'undo_result', session, turn, report: result.UndoCompleted.report });
  }
}
