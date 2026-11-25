import { randomUUID } from 'node:crypto';
import { WorkbenchClient, WorkbenchError, WORKBENCH_LIMITS } from './workbench-client';
import {
  durableCommand,
  usesReservedWorkflow,
  operationId,
  type ClientCommand,
  type OperationId,
} from './workbench-protocol';
import { uiOperation, type UiOperation } from './workbench-ui';

/** Receipt observers only: recovery never resends an accepted command. */
export class WorkbenchOperations {
  rows: UiOperation[] = [];
  private workflows = new Map<OperationId, ClientCommand>();
  active(operation: OperationId) {
    return this.workflows.get(operation);
  }
  private persistence: Promise<void> = Promise.resolve();
  private recoveryFlight?: Promise<void>;
  constructor(
    private client: WorkbenchClient,
    saved: unknown,
    private save: ((rows: UiOperation[]) => PromiseLike<void>) | undefined,
    private closed: () => boolean,
    private changed: () => void,
    private settled: () => void,
  ) {
    if (Array.isArray(saved) && saved.length <= 64) {
      for (const value of saved) {
        try {
          const row = uiOperation.parse(value);
          if (row.status === 'pending') row.status = 'uncertain';
          this.rows.push(row);
        } catch {
          /* Invalid local preferences never authorize a command. */
        }
      }
    }
  }
  private persistOperations() {
    const saved = this.rows.map((row) => ({ ...row }));
    const task = this.persistence.catch(() => {}).then(() => this.save?.(saved));
    this.persistence = task;
    return task;
  }
  recover(): Promise<void> {
    if (this.recoveryFlight) return this.recoveryFlight;
    const task = this.queryOperations();
    this.recoveryFlight = task;
    void task
      .finally(() => {
        if (this.recoveryFlight === task) this.recoveryFlight = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async queryOperations() {
    for (const row of this.rows) {
      if (!['pending', 'uncertain'].includes(row.status) || this.workflows.has(row.operation))
        continue;
      const result = await this.client.call(
        { method: 'operation', operation: row.operation },
        { timeoutMs: 10_000 },
      );
      if (this.closed()) return;
      row.status =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'failed' || result.status === 'expired'
            ? 'failed'
            : 'uncertain';
      if (result.status === 'completed' && 'HistoryClear' in result.receipt)
        row.historyClear = result.receipt.HistoryClear.report;
      row.code = result.status;
      row.error =
        result.status === 'failed'
          ? result.message
          : result.status === 'unknown'
            ? 'No durable receipt found. No request was resent.'
            : result.status === 'uncertain'
              ? 'Acceptance or external outcome is uncertain. Inspect the session; no request was resent.'
              : result.status === 'expired'
                ? 'Receipt expired; this operation cannot execute again.'
                : undefined;
    }
    await this.persistOperations();
  }
  async stopTrackingUnknown(operations: OperationId[]) {
    await this.recoveryFlight;
    for (const row of this.rows) {
      if (
        operations.includes(row.operation) &&
        row.status === 'uncertain' &&
        row.code === 'unknown' &&
        !this.workflows.has(row.operation)
      ) {
        row.status = 'untracked';
        row.error = 'Stopped local receipt tracking at your request. Outcome remains unknown.';
      }
    }
    await this.persistOperations();
    this.changed();
  }
  async execute(command: ClientCommand, admitted?: (operation: OperationId) => void) {
    if (!durableCommand(command)) throw new Error('Expected a mutation');
    // Bound both retained receipt display and concurrent long-running workflows.
    const control = usesReservedWorkflow(command.method);
    const pending = this.rows.filter(
      (row) => row.status === 'pending' && usesReservedWorkflow(row.method) === control,
    );
    if (pending.length >= WORKBENCH_LIMITS.pools[control ? 1 : 0])
      throw new Error('Too many UI workflows are active');
    const unresolved = this.rows.filter((row) => ['pending', 'uncertain'].includes(row.status));
    if (unresolved.length >= (control ? 64 : 48))
      throw new Error('Resolve uncertain operation receipts before starting more workflows');
    const operation = operationId.parse(randomUUID());
    admitted?.(operation);
    const row: UiOperation = {
      operation,
      method: command.method,
      ...('session' in command ? { session: command.session } : {}),
      status: 'pending',
    };
    const terminal = this.rows.filter((row) => !['pending', 'uncertain'].includes(row.status));
    const terminalSlots = Math.min(47, 63 - unresolved.length);
    this.rows = [...unresolved, ...(terminalSlots ? terminal.slice(-terminalSlots) : []), row];
    this.changed();
    try {
      // Persist only a handle before bytes can leave this process, never a
      // command body. Reload may query this identity but cannot replay it.
      await this.persistOperations();
      if (this.closed()) throw new Error('Workbench view closed before dispatch');
      const ticket = this.client.request(command, { operation });
      this.workflows.set(operation, command);
      const result = await ticket.result;
      row.status = 'completed';
      if ('HistoryClear' in result) row.historyClear = result.HistoryClear.report;
      return result;
    } catch (error) {
      row.status =
        error instanceof WorkbenchError && error.sideEffectPossible ? 'uncertain' : 'failed';
      row.error = error instanceof Error ? error.message : 'Operation failed';
      if (error instanceof WorkbenchError) row.code = error.code;
      throw error;
    } finally {
      this.workflows.delete(operation);
      this.settled();
      await this.persistOperations();
      this.changed();
    }
  }
}
