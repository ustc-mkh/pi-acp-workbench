import type { ImageAsset } from '../src/workbench-protocol';
import type { TextAttachment, TypedPrompt } from '../src/workbench-input';
import type { WorkbenchUiMessage, WorkbenchUiState } from '../src/workbench-ui';

interface DraftSnapshot {
  text: string;
  attachments: TextAttachment[];
  image?: ImageAsset;
}
interface PendingDraft extends DraftSnapshot {
  generation: number;
  after: number;
}
/** Correlates acknowledgements with draft generations; never replays input. */
export class Submissions {
  private pending = new Map<string, Set<string>>();
  private generations = new Map<string, number>();
  private operations = new Map<string, { generation: number; operation: string }>();
  private piDrafts = new Map<string, PendingDraft>();
  private nextGeneration = 0;
  has(session: string) {
    return this.pending.has(session);
  }
  touch(session: string) {
    if (!this.generations.has(session) && this.generations.size >= 64)
      this.generations.delete(this.generations.keys().next().value!);
    this.generations.set(session, ++this.nextGeneration);
  }
  begin(session: string, harness: string, operations: WorkbenchUiState['operations']) {
    if (harness === 'Pi' && !this.piDrafts.has(session) && this.piDrafts.size >= 16)
      throw new Error('仍有输入等待 Agent 确认，请先查看这些会话的状态。');
    if (this.pending.size >= 16)
      throw new Error('Too many pending input receipts; check operations before sending.');
    this.touch(session);
    this.pending.set(session, new Set(operations.map((row) => row.operation)));
    return this.generations.get(session)!;
  }
  observe(state: WorkbenchUiState) {
    for (const [session, previous] of this.pending)
      if (
        state.error ||
        state.operations.some(
          (row) =>
            row.session === session &&
            row.method === 'prompt' &&
            !previous.has(row.operation) &&
            row.status !== 'pending',
        )
      )
        this.pending.delete(session);
  }
  submitted(message: Extract<WorkbenchUiMessage, { type: 'prompt_submitted' }>) {
    if (
      message.generation === undefined ||
      message.generation !== this.generations.get(message.session)
    )
      return;
    if (this.operations.size >= 64) this.operations.delete(this.operations.keys().next().value!);
    this.operations.set(message.session, {
      generation: message.generation,
      operation: message.operation,
    });
  }
  accept(
    message: Extract<WorkbenchUiMessage, { type: 'prompt_accepted' }>,
    current: () => { prompt: TypedPrompt; draft: DraftSnapshot },
  ) {
    const submitted = this.operations.get(message.session);
    if (
      !submitted ||
      message.operation !== submitted.operation ||
      message.generation !== submitted.generation
    )
      return { matched: false, clear: false };
    this.pending.delete(message.session);
    this.operations.delete(message.session);
    let clear = false;
    try {
      const { prompt, draft } = current();
      clear =
        message.generation === (this.generations.get(message.session) || 0) &&
        JSON.stringify(message.prompt) === JSON.stringify(prompt);
      if (clear && message.pi_after_seq !== undefined)
        this.piDrafts.set(message.session, {
          ...draft,
          generation: message.generation!,
          after: message.pi_after_seq,
        });
    } catch {
      /* Changed or invalid drafts are never cleared by old acknowledgements. */
    }
    return { matched: true, clear };
  }
  settle(session: string, state: WorkbenchUiState | undefined, hasContent: boolean) {
    const pending = this.piDrafts.get(session);
    if (!pending || !state?.view?.view) return;
    const turn = state.view.entries.find(
      (row) => row.seq > pending.after && row.role === 'User',
    )?.turn;
    if (!turn) return;
    const rows = state.view.entries.filter((row) => row.turn === turn);
    const rejected = rows.some((row) => row.message === 'pi-workbench-input-rejected');
    if (!rejected && !rows.some((row) => row.role !== 'User') && state.view.view.active_turn)
      return;
    this.piDrafts.delete(session);
    if (rejected)
      return {
        draft: pending,
        restore: pending.generation === (this.generations.get(session) || 0) && !hasContent,
      };
  }
}
