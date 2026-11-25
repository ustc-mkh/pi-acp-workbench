import { setTimeout as delay } from 'node:timers/promises';
import { HistoryText } from './workbench-history-text';
import {
  loadHistoryTurns,
  validateHistoryPage,
  boundRecentHistory,
  historyFits,
  INITIAL_HISTORY_TURNS,
  EARLIER_HISTORY_TURNS,
} from './workbench-history';
import { WorkbenchClient, WorkbenchError } from './workbench-client';
import {
  jsonBytes,
  MAX_HISTORY_LIMIT,
  MAX_QUERY_BYTES,
  type CommitBatch,
  type EntryHeader,
  type HistoryCursor,
  type HistoryTurnPage,
  type SessionId,
  type SessionView,
  type ToolHeader,
  type ToolCursor,
} from './workbench-protocol';

export interface WorkbenchSessionView {
  readonly status: 'syncing' | 'ready' | 'stale' | 'removed' | 'disconnected';
  readonly view?: SessionView;
  readonly entries: readonly EntryHeader[];
  readonly resolvedText?: Readonly<Record<string, string>>;
  readonly tools: readonly ToolHeader[];
  readonly emptyToolTurns?: readonly EntryHeader['turn'][];
  readonly toolCursor?: ToolCursor;
  readonly earlier?: HistoryCursor;
  readonly historical: boolean;
  readonly historyTruncated?: boolean;
  readonly loadingEarlier?: boolean;
  readonly earlierLoaded?: number;
  readonly earlierError?: string;
  readonly error?: string;
}
function mergeTools(current: readonly ToolHeader[], incoming: readonly ToolHeader[]) {
  const tools = new Map(current.map((tool) => [`${tool.turn}:${tool.id}`, tool]));
  for (const tool of incoming) tools.set(`${tool.turn}:${tool.id}`, tool);
  const recent = [...tools.values()].slice(-MAX_HISTORY_LIMIT);
  let bytes = jsonBytes(recent);
  let start = 0;
  while (bytes > MAX_QUERY_BYTES) bytes -= jsonBytes(recent[start++]) + 1;
  return start ? recent.slice(start) : recent;
}

/** Bounded confirmed page projection. No provisional rows, domain reducer or
 * polling. Reattach after gaps; never replay an uncertain mutation. */
export class WorkbenchSession {
  private active = false;
  private ended = false;
  private attaching = false;
  private generation = 0;
  private text = new HistoryText();
  private resolvingText = false;
  private visibleText: readonly string[] = [];
  private textDemand = 0;
  private toolsReadSequence = 0;
  private toolTurnRequests = new Map<string, number>();
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
  /** Discovery receipts contain a confirmed hot view, but no transcript rows.
   * Adopt a newer receipt only for an empty session; otherwise preserve the
   * contiguous stream or reattach rather than skipping unseen message rows. */
  confirmEmptyView(view: SessionView): boolean {
    const current = this.current.view;
    if (
      !this.active ||
      this.attaching ||
      this.current.status !== 'ready' ||
      !current ||
      view.id !== this.id
    )
      return false;
    if (current.revision >= view.revision) return true;
    if (
      this.current.entries.length ||
      current.last_entry_seq ||
      view.last_entry_seq ||
      current.active_turn ||
      view.active_turn ||
      view.status !== 'Idle' ||
      Object.keys(view.pending_interactions).length
    )
      return false;
    this.publish({ view });
    return true;
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
        if (!this.active || this.current.status === 'removed') return;
        this.invalidateRequests();
        this.publish({
          status: 'disconnected',
          loadingEarlier: false,
          earlierError: this.current.loadingEarlier
            ? '连接中断，历史加载已停止。恢复连接后可重试。'
            : this.current.earlierError,
          error: 'Workbench disconnected; restoring observation without resending requests',
        });
      },
    });
    return (this.startTask = this.refresh());
  }
  private invalidateRequests() {
    this.pending = [];
    this.pendingBytes = 0;
    return ++this.generation;
  }
  private stale(error: string) {
    if (!this.active || this.current.status === 'removed') return;
    this.invalidateRequests();
    this.publish({
      status: 'stale',
      loadingEarlier: false,
      earlierError: this.current.loadingEarlier
        ? '会话正在重新同步，历史加载已停止。同步完成后可重试。'
        : this.current.earlierError,
      error,
    });
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
      this.removed();
      return;
    }
    if (!batch.view) {
      this.stale('Commit has no hot view; explicitly reattach');
      return;
    }
    let entries = this.current.entries;
    let historyTruncated = this.current.historyTruncated;
    if (batch.entries.length) {
      const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
      for (const entry of batch.entries) {
        const prior = bySeq.get(entry.seq);
        if ((prior && prior.id !== entry.id) || entry.seq > batch.view.last_entry_seq) {
          this.stale('Entry identity mismatch');
          return;
        }
        bySeq.set(entry.seq, entry);
      }
      const bounded = boundRecentHistory([...bySeq.values()].sort((a, b) => a.seq - b.seq));
      entries = bounded.entries;
      historyTruncated =
        bounded.partial || (historyTruncated && entries[0]?.turn === this.current.entries[0]?.turn);
    }
    const minimum = entries[0]?.seq;
    const earlier: HistoryCursor | undefined =
      minimum && minimum > 1
        ? {
            version: 3,
            session: this.id,
            max_entry_seq: batch.view.last_entry_seq,
            before_seq: minimum,
          }
        : undefined;
    const updatedToolTurns = new Set(batch.tools.map((tool) => tool.turn));
    this.publish({
      view: batch.view,
      entries,
      historyTruncated,
      tools: batch.tools.length ? mergeTools(this.current.tools, batch.tools) : this.current.tools,
      emptyToolTurns: this.current.emptyToolTurns?.filter((turn) => !updatedToolTurns.has(turn)),
      earlier,
      error: undefined,
    });
    if (batch.entries.some((row) => 'Archived' in row.text)) this.requestText();
  }
  setVisibleHistoryText(ids: readonly string[]) {
    if (ids.length === this.visibleText.length && ids.every((id, i) => id === this.visibleText[i]))
      return;
    this.visibleText = ids;
    this.requestText();
  }
  private removed() {
    this.invalidateRequests();
    this.publish({
      status: 'removed',
      view: undefined,
      entries: [],
      tools: [],
      earlier: undefined,
      loadingEarlier: false,
      earlierError: undefined,
      earlierLoaded: undefined,
      resolvedText: undefined,
      toolCursor: undefined,
      emptyToolTurns: undefined,
      historical: false,
      historyTruncated: false,
      error: undefined,
    });
  }
  private requestText() {
    this.textDemand++;
    void this.resolveCurrentText();
  }
  private async resolveCurrentText() {
    const ready = () => this.active && this.current.status === 'ready';
    if (this.resolvingText || !ready()) return;
    this.resolvingText = true;
    let handled = this.textDemand;
    try {
      do {
        handled = this.textDemand;
        const generation = this.generation;
        const valid = () => ready() && generation === this.generation;
        const entries = this.current.entries;
        const archiveRows = new Map<string, EntryHeader>();
        for (const row of entries)
          if ('Archived' in row.text) archiveRows.set(row.text.Archived.content.id, row);
        const prioritized: EntryHeader[] = [];
        for (const id of this.visibleText) {
          const row = archiveRows.get(id);
          if (row) {
            prioritized.push(row);
            archiveRows.delete(id);
          }
        }
        if (!this.current.historical) prioritized.push(...[...archiveRows.values()].reverse());
        try {
          await this.text.resolve(
            this.client,
            prioritized,
            valid,
            () => this.publish({ resolvedText: this.text.snapshot(this.current.entries) }),
            (id) => !this.current.historical || this.visibleText.includes(id),
          );
        } catch {
          // A transient query failure leaves the preview and explicit read available.
          // Subsequent viewport/live changes can retry the batch.
        }
      } while (ready() && handled !== this.textDemand);
    } finally {
      this.resolvingText = false;
    }
  }
  refresh(): Promise<void> {
    if (!this.active || this.current.status === 'removed') return Promise.resolve();
    if (this.flight) return this.flight;
    const generation = this.invalidateRequests();
    const valid = () => generation === this.generation;
    this.attaching = true;
    this.visibleText = [];
    this.publish({ status: 'syncing', loadingEarlier: false, error: undefined });
    const task = (async () => {
      try {
        const attached = await this.client.call(
          { method: 'attach', session: this.id },
          { timeoutMs: 10_000 },
        );
        if (!valid()) return;
        if (
          attached.view.id !== this.id ||
          attached.recent_page.entries.some((entry) => entry.seq > attached.view.last_entry_seq)
        )
          throw new WorkbenchError('protocol', 'Invalid attach scope');
        const recent = await loadHistoryTurns(
          this.client,
          this.id,
          attached.recent_page,
          attached.view.last_entry_seq,
          INITIAL_HISTORY_TURNS,
          valid,
        );
        if (!recent || !valid()) return;
        this.publish({
          resolvedText: this.text.snapshot(recent.entries),
          view: attached.view,
          entries: recent.entries,
          historyTruncated: recent.truncated,
          tools: [],
          emptyToolTurns: undefined,
          toolCursor: undefined,
          earlier: recent.next_cursor ?? undefined,
          historical: false,
          status: 'ready',
          error: undefined,
        });
        this.attaching = false;
        const buffered = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const batch of buffered) this.batch(batch);
        this.requestText();
      } catch (error) {
        if (valid()) {
          if (error instanceof WorkbenchError && error.code === 'not_found') this.removed();
          else
            this.publish({
              status: 'stale',
              error: error instanceof Error ? error.message : 'Cannot attach session',
            });
        }
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
    let cursor = this.current.earlier;
    if (!this.active || this.current.status === 'removed' || this.current.loadingEarlier) return;
    if (this.current.status !== 'ready') {
      this.publish({ earlierError: '会话正在重新连接或同步，请稍后重试。' });
      return;
    }
    if (!cursor) {
      this.publish({ earlierError: undefined, earlierLoaded: 0 });
      return;
    }
    const generation = this.generation;
    const valid = () => generation === this.generation;
    let remaining = EARLIER_HISTORY_TURNS;
    let pending: EntryHeader[] = [];
    let boundary = cursor.before_seq;
    let retries = 0;
    this.publish({ loadingEarlier: true, earlierLoaded: 0, earlierError: undefined });
    try {
      while (cursor && remaining > 0 && valid()) {
        let page: HistoryTurnPage;
        try {
          page = await this.client.call(
            {
              method: 'history_turns',
              session: this.id,
              cursor,
              turns: pending.length ? 1 : remaining,
            },
            { timeoutMs: 10_000 },
          );
        } catch (error) {
          if (
            valid() &&
            error instanceof WorkbenchError &&
            error.code === 'backpressure' &&
            retries < 3
          ) {
            await delay(100 * 2 ** retries++);
            continue;
          }
          throw error;
        }
        retries = 0;
        if (!valid()) return;
        validateHistoryPage(page, cursor, this.id, cursor.max_entry_seq);
        const turns = new Set(page.entries.map((row) => row.turn));
        if (
          ((page.partial || pending.length > 0) &&
            (turns.size !== 1 || (pending.length > 0 && !turns.has(pending[0].turn)))) ||
          turns.size > remaining
        )
          throw new Error('历史分页未向前推进，请重新加载会话。');

        cursor = page.next_cursor ?? undefined;
        const older = pending.length ? [...page.entries, ...pending] : page.entries;
        const entries = [...older, ...this.current.entries];
        if (this.current.entries[0]?.seq !== boundary || !historyFits(entries))
          throw new Error('历史显示已达上限，请使用箭头回到最近 3 轮，或导出完整历史。');
        if (page.partial) {
          pending = older;
          continue;
        }

        pending = [];
        remaining -= turns.size;
        boundary = entries[0].seq;
        this.publish({
          entries,
          earlier: cursor,
          earlierLoaded: EARLIER_HISTORY_TURNS - remaining,
          historical: this.current.historical || older.length > 0,
        });
      }
    } catch (error) {
      if (valid()) {
        const message =
          error instanceof WorkbenchError && error.code === 'backpressure'
            ? '历史查询繁忙，请重试。'
            : error instanceof WorkbenchError && error.code === 'timeout'
              ? '加载更早消息超时，请重试。'
              : error instanceof Error
                ? error.message
                : '加载更早消息失败，请重试。';
        this.publish({ earlierError: message });
      }
    } finally {
      if (valid()) this.publish({ loadingEarlier: false });
    }
  }
  async latest() {
    if (!this.active || this.current.status === 'removed') return;
    this.publish({ earlierError: undefined, earlierLoaded: undefined });
    await this.refresh();
  }
  async loadTools(turn: EntryHeader['turn'], cursor?: ToolCursor) {
    if (!this.active || this.current.status !== 'ready') return;
    const generation = this.generation;
    const request = ++this.toolsReadSequence;
    this.toolTurnRequests.set(turn, request);
    while (this.toolTurnRequests.size > 256)
      this.toolTurnRequests.delete(this.toolTurnRequests.keys().next().value!);
    const requestedRevision = this.current.view?.revision;
    const wasActive = this.current.view?.active_turn === turn;
    const page = await this.client.call({
      method: 'tools',
      session: this.id,
      turn,
      cursor,
      limit: MAX_HISTORY_LIMIT,
    });
    if (generation !== this.generation || request !== this.toolTurnRequests.get(turn)) return;
    if (wasActive && requestedRevision !== this.current.view?.revision) return;
    const retained = cursor
      ? this.current.tools
      : this.current.tools.filter((tool) => tool.turn !== turn);
    this.publish({
      tools: mergeTools(retained, page.tools),
      emptyToolTurns:
        !cursor && !page.tools.length
          ? [...new Set([...(this.current.emptyToolTurns || []), turn])].slice(-256)
          : this.current.emptyToolTurns?.filter((id) => id !== turn),
      toolCursor: page.next_cursor ?? undefined,
      error: undefined,
    });
  }
  async stop() {
    if (this.ended) return;
    const connected = this.current.status !== 'disconnected';
    this.ended = true;
    this.active = false;
    this.invalidateRequests();
    this.unobserve?.();
    this.listeners.clear();
    if (!connected) return;
    try {
      await this.client.call({ method: 'detach', session: this.id });
    } catch {
      /* disconnected/disposed */
    }
  }
}
