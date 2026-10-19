import { WorkbenchClient, WorkbenchError } from './workbench-client';
import {
  jsonBytes,
  type CommitBatch,
  type EntryHeader,
  type HistoryCursor,
  type SessionId,
  type SessionView,
  type ToolHeader,
  type ToolCursor,
} from './workbench-protocol';

export interface WorkbenchSessionView {
  readonly status: 'syncing' | 'ready' | 'stale' | 'removed' | 'disconnected';
  readonly view?: SessionView;
  readonly entries: readonly EntryHeader[];
  readonly tools: readonly ToolHeader[];
  readonly toolCursor?: ToolCursor;
  readonly earlier?: HistoryCursor;
  readonly historical: boolean;
  readonly error?: string;
}
/** Bounded confirmed page projection. No provisional rows, domain reducer or
 * polling. Reattach after gaps; never replay an uncertain mutation. */
export class WorkbenchSession {
  private active = false;
  private ended = false;
  private attaching = false;
  private generation = 0;
  private historyRequest = 0;
  private toolsRequest = 0;
  private pending: CommitBatch[] = [];
  private pendingBytes = 0;
  private startTask?: Promise<void>;
  private flight?: Promise<void>;
  private unobserve?: () => void;
  private current: WorkbenchSessionView = {
    status: 'syncing',
    entries: [],
    tools: [],
    historical: false,
  };
  private listeners = new Set<(view: WorkbenchSessionView) => void>();
  constructor(
    readonly client: WorkbenchClient,
    readonly id: SessionId,
  ) {}
  get view() {
    return this.current;
  }
  observe(listener: (view: WorkbenchSessionView) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(change: Partial<WorkbenchSessionView>) {
    this.current = { ...this.current, ...change };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch {
        /* observer isolation */
      }
    }
  }
  start(): Promise<void> {
    if (this.ended) return Promise.reject(new WorkbenchError('closed', 'Session view is stopped'));
    if (this.startTask) return this.startTask;
    this.active = true;
    this.unobserve = this.client.observe({
      batch: (batch) => this.batch(batch),
      resync: () => this.stale('Workbench revision gap; reattach required'),
      lost: () => {
        this.generation++;
        this.historyRequest++;
        this.toolsRequest++;
        this.pending = [];
        this.pendingBytes = 0;
        this.publish({
          status: 'disconnected',
          error: 'Workbench disconnected; explicitly reattach to continue',
        });
      },
    });
    return (this.startTask = this.refresh());
  }
  private stale(error: string) {
    if (!this.active) return;
    this.generation++;
    this.historyRequest++;
    this.toolsRequest++;
    this.pending = [];
    this.pendingBytes = 0;
    this.publish({ status: 'stale', error });
  }
  private batch(batch: CommitBatch) {
    if (!this.active || batch.session !== this.id || this.current.status === 'removed') return;
    if (this.attaching) {
      const bytes = jsonBytes(batch);
      if (this.pending.length >= 1000 || this.pendingBytes + bytes > 4 * 1024 * 1024) {
        this.stale('Attach buffer exceeded; explicitly reattach');
        return;
      }
      this.pending.push(batch);
      this.pendingBytes += bytes;
      return;
    }
    const view = this.current.view;
    if (!view || this.current.status !== 'ready' || batch.revision <= view.revision) return;
    if (batch.revision !== view.revision + 1) {
      this.stale('Workbench revision gap; explicitly reattach');
      return;
    }
    if (batch.removed) {
      this.publish({
        status: 'removed',
        view: undefined,
        entries: [],
        tools: [],
        earlier: undefined,
        toolCursor: undefined,
        historical: false,
      });
      return;
    }
    if (!batch.view) {
      this.stale('Commit has no hot view; explicitly reattach');
      return;
    }
    let entries = [...this.current.entries];
    let earlier: HistoryCursor | undefined = this.current.earlier;
    if (!this.current.historical) {
      const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
      for (const entry of batch.entries) {
        const prior = bySeq.get(entry.seq);
        if ((prior && prior.id !== entry.id) || entry.seq > batch.view.last_entry_seq) {
          this.stale('Entry identity mismatch');
          return;
        }
        bySeq.set(entry.seq, entry);
      }
      entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      let bytes = entries.reduce(
        (total, entry) => total + jsonBytes(entry),
        2 + Math.max(0, entries.length - 1),
      );
      while (entries.length > 200 || bytes > 4 * 1024 * 1024) {
        const removed = entries.shift();
        if (removed) bytes -= jsonBytes(removed) + (entries.length ? 1 : 0);
      }
      const minimum = entries[0]?.seq;
      earlier =
        minimum && minimum > 1
          ? {
              version: 3,
              session: this.id,
              max_entry_seq: batch.view.last_entry_seq,
              before_seq: minimum,
            }
          : undefined;
    }
    const tools = new Map(this.current.tools.map((tool) => [`${tool.turn}:${tool.id}`, tool]));
    for (const tool of batch.tools) tools.set(`${tool.turn}:${tool.id}`, tool);
    const boundedTools = [...tools.values()];
    while (boundedTools.length > 200 || jsonBytes(boundedTools) > 1024 * 1024) boundedTools.shift();
    this.publish({ view: batch.view, entries, tools: boundedTools, earlier, error: undefined });
  }
  refresh(): Promise<void> {
    if (!this.active || this.ended || this.current.status === 'removed') return Promise.resolve();
    if (this.flight) return this.flight;
    const generation = ++this.generation;
    this.historyRequest++;
    this.toolsRequest++;
    this.attaching = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.publish({ status: 'syncing', error: undefined });
    const task = (async () => {
      try {
        const attached = await this.client.call({ method: 'attach', session: this.id });
        if (!this.active || generation !== this.generation) return;
        if (
          attached.view.id !== this.id ||
          attached.recent_page.entries.some((entry) => entry.seq > attached.view.last_entry_seq)
        )
          throw new WorkbenchError('protocol', 'Invalid attach scope');
        this.publish({
          view: attached.view,
          entries: attached.recent_page.entries,
          tools: [],
          earlier: attached.recent_page.next_cursor ?? undefined,
          historical: false,
          status: 'ready',
          error: undefined,
        });
        this.attaching = false;
        const buffered = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const batch of buffered) this.batch(batch);
      } catch (error) {
        if (this.active && generation === this.generation)
          this.publish({
            status: 'stale',
            error: error instanceof Error ? error.message : 'Cannot attach session',
          });
      } finally {
        this.attaching = false;
      }
    })();
    this.flight = task;
    void task.finally(() => {
      if (this.flight === task) this.flight = undefined;
    });
    return task;
  }
  async earlier() {
    const cursor = this.current.earlier;
    if (!cursor || !this.active || this.current.status !== 'ready') return;
    const generation = this.generation;
    const request = ++this.historyRequest;
    const page = await this.client.call({
      method: 'history',
      session: this.id,
      cursor,
      limit: 200,
    });
    if (!this.active || generation !== this.generation || request !== this.historyRequest) return;
    this.publish({
      entries: page.entries,
      earlier: page.next_cursor ?? undefined,
      historical: true,
      error: undefined,
    });
  }
  async latest() {
    if (!this.active || this.current.status === 'removed') return;
    await this.refresh();
  }
  async loadTools(turn: EntryHeader['turn'], cursor?: ToolCursor) {
    if (!this.active || this.current.status !== 'ready') return;
    const generation = this.generation;
    const request = ++this.toolsRequest;
    const requestedRevision = this.current.view?.revision;
    const page = await this.client.call({
      method: 'tools',
      session: this.id,
      turn,
      cursor,
      limit: 200,
    });
    if (!this.active || generation !== this.generation || request !== this.toolsRequest) return;
    if (requestedRevision !== this.current.view?.revision) return;
    this.publish({
      tools: page.tools,
      toolCursor: page.next_cursor ?? undefined,
      error: undefined,
    });
  }
  async stop() {
    if (this.ended) return;
    const connected = this.current.status !== 'disconnected';
    this.ended = true;
    this.active = false;
    this.generation++;
    this.historyRequest++;
    this.toolsRequest++;
    this.unobserve?.();
    this.pending = [];
    this.pendingBytes = 0;
    this.listeners.clear();
    if (!connected) return;
    try {
      await this.client.call({ method: 'detach', session: this.id });
    } catch {
      /* disconnected/disposed */
    }
  }
}
