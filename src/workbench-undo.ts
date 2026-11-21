import type { WorkbenchClient } from './workbench-client';
import type { WorkbenchPorts } from './workbench-controller';
import type { WorkbenchOperations } from './workbench-operations';
import type { ClientCommand } from './workbench-protocol';
import type { WorkbenchSession } from './workbench-session';

export class WorkbenchUndo {
  confirming = false;
  constructor(
    private client: WorkbenchClient,
    private ports: Pick<WorkbenchPorts, 'confirmUndo' | 'validateUndo' | 'post'>,
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
      if (selected.view.status !== 'ready' || selected.view.view?.active_turn)
        throw new Error('Wait for the active task to finish before undo');
    };
    check();
    if (!selected.view.entries.some((row) => row.turn === turn))
      throw new Error('Turn is not in confirmed history');
    if (this.confirming) throw new Error('Finish or cancel the undo confirmation first');
    this.confirming = true;
    try {
      await this.client.call({ method: 'validate_undo', session, turn, files });
      check();
      if (!(await this.ports.confirmUndo?.(session, turn, files ?? undefined))) return;
      check();
      await this.ports.validateUndo?.(session, turn);
      check();
    } finally {
      this.confirming = false;
    }
    const result = await this.receipts.execute(command);
    if (result && typeof result === 'object' && 'UndoCompleted' in result)
      this.ports.post({ type: 'undo_result', session, turn, report: result.UndoCompleted.report });
  }
}
