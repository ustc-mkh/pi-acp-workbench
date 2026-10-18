import { WorkbenchClient, WorkbenchError } from './workbench-client';
import type { DomainEvent, SessionId, SessionSnapshot } from './workbench-protocol';

type Entry = SessionSnapshot['transcript']['entries'][number];
export interface WorkbenchSessionView {
  readonly status: 'syncing' | 'ready' | 'stale' | 'removed' | 'disconnected';
  readonly snapshot?: SessionSnapshot;
  /** Live identity-bearing rows are display-only until confirmed by a fresh snapshot. */
  readonly provisional: readonly Entry[];
  readonly error?: string;
}
export function eventSession(event: DomainEvent): SessionId | undefined {
  if ('SessionsListed' in event) return undefined;
  if ('SessionCreated' in event) return event.SessionCreated.id;
  if ('SessionLoaded' in event) return event.SessionLoaded.id;
  if ('SessionRemoved' in event) return event.SessionRemoved;
  return Object.values(event)[0].session;
}
/**
 * Read-only view projection, never a second domain reducer. Event payloads have
 * no revision, so replaying buffered lifecycle/config events over an inspect
 * reply would regress state. They instead invalidate/coalesce authoritative
 * cold inspect reads; entry IDs support bounded, provisional live display.
 */
export class WorkbenchSession {
  private active = false;
  private ended = false;
  private removed = false;
  private dirty = false;
  private generation = 0;
  private startTask?: Promise<void>;
  private flight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private unobserve?: () => void;
  private rows = new Map<string, Entry>();
  private committed = new Set<string>();
  private rowBytes = 0;
  private current: WorkbenchSessionView = { status: 'syncing', provisional: [] };
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
    this.current = { ...this.current, ...change, provisional: [...this.rows.values()] };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch {
        /* a view observer cannot interrupt transport/cleanup */
      }
    }
  }
  start(): Promise<void> {
    if (this.ended) return Promise.reject(new WorkbenchError('closed', 'Session view is stopped'));
    if (this.startTask)
      return this.active
        ? this.startTask
        : Promise.reject(
            new WorkbenchError('closed', 'Explicit reattachment needs a new session view'),
          );
    this.active = true;
    this.unobserve = this.client.observe({
      event: (event) => this.event(event),
      resync: () => {
        if (!this.active) return;
        this.generation++;
        this.rows.clear();
        this.rowBytes = 0;
        this.publish({ status: 'stale' });
        this.invalidate();
      },
      lost: () => {
        this.generation++;
        this.active = false;
        this.unobserve?.();
        this.unobserve = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.rows.clear();
        this.rowBytes = 0;
        this.publish({
          status: 'disconnected',
          error: 'Workbench disconnected; explicit reattachment required',
        });
      },
    });
    return (this.startTask = (async () => {
      try {
        await this.client.call({ method: 'subscribe', session: this.id });
        if (this.active) await this.refresh();
      } catch (error) {
        if (this.active) this.publish({ status: 'stale', error: this.message(error) });
        throw error;
      }
    })());
  }
  private event(event: DomainEvent) {
    if (!this.active || this.removed || eventSession(event) !== this.id) return;
    if ('SessionRemoved' in event) {
      this.removed = true;
      this.generation++;
      this.dirty = false;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.rows.clear();
      this.rowBytes = 0;
      this.publish({ status: 'removed', snapshot: undefined, error: undefined });
      return;
    }
    let row: Entry | undefined;
    if ('UserPromptAdded' in event) {
      const e = event.UserPromptAdded;
      row = { id: e.entry, turn: e.turn, role: 'User', text: e.prompt };
    } else if ('AgentText' in event || 'AgentThought' in event) {
      const thought = 'AgentThought' in event;
      const e = 'AgentText' in event ? event.AgentText : event.AgentThought;
      row = {
        id: e.entry,
        turn: e.turn,
        role: thought ? 'Thought' : 'Agent',
        text: e.text,
        ...(e.message === null ? {} : { message: e.message }),
      };
    } else if ('AgentImage' in event) {
      const e = event.AgentImage;
      row = {
        id: e.entry,
        turn: e.turn,
        role: 'Agent',
        text: '',
        image: e.image,
        ...(e.message === null ? {} : { message: e.message }),
      };
    }
    if (row && !this.rows.has(row.id) && !this.committed.has(row.id)) {
      const bytes = Buffer.byteLength(row.text);
      if (this.rows.size < 256 && this.rowBytes + bytes <= 1024 * 1024) {
        this.rows.set(row.id, row);
        this.rowBytes += bytes;
      }
    }
    // Includes configuration/catalogue/interactions/tool changes: do not infer
    // authoritative status or safe fork positions from their arrival order.
    this.publish({ status: 'stale' });
    this.invalidate();
  }
  private invalidate() {
    this.dirty = true;
    if (!this.active || this.removed || this.flight || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => {});
    }, 50);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if (!this.active || this.removed) return Promise.resolve();
    if (this.flight) return this.flight;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    const generation = this.generation;
    const task = (async () => {
      try {
        const events = await this.client.call({ method: 'inspect', session: this.id });
        if (!this.active || this.removed || generation !== this.generation) return;
        const snapshot = events.flatMap((event) =>
          'SessionLoaded' in event ? [event.SessionLoaded] : [],
        );
        if (snapshot.length !== 1 || snapshot[0].id !== this.id)
          throw new WorkbenchError('protocol', 'Invalid inspect response');
        const next = snapshot[0];
        if (this.current.snapshot && next.revision < this.current.snapshot.revision) {
          this.dirty = true;
          return;
        }
        this.committed = new Set(next.transcript.entries.map((entry) => entry.id));
        for (const [id, row] of this.rows) {
          if (this.committed.has(id) || (!this.dirty && next.active_turn !== row.turn)) {
            this.rows.delete(id);
            this.rowBytes -= Buffer.byteLength(row.text);
          }
        }
        this.publish({ snapshot: next, status: this.dirty ? 'stale' : 'ready', error: undefined });
      } catch (error) {
        if (!this.active || this.removed || generation !== this.generation) return;
        if (error instanceof WorkbenchError && error.code === 'not_found') {
          this.removed = true;
          this.rows.clear();
          this.rowBytes = 0;
          this.publish({ status: 'removed', snapshot: undefined, error: undefined });
        } else {
          this.publish({ status: 'stale', error: this.message(error) });
          // No tight retry loop for persistent I/O/corruption errors. A new
          // event, explicit refresh or resync may trigger another cold query.
        }
      }
    })();
    this.flight = task;
    void task.finally(() => {
      if (this.flight === task) this.flight = undefined;
      if (this.dirty) this.invalidate();
    });
    return task;
  }
  private message(error: unknown) {
    return error instanceof WorkbenchError ? error.message : 'Cannot refresh workbench session';
  }
  async stop() {
    if (this.ended) return;
    const subscribed = this.active;
    this.ended = true;
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unobserve?.();
    this.unobserve = undefined;
    this.listeners.clear();
    // The accepted inspect remains owned by the host; only detach this view.
    if (subscribed) {
      try {
        await this.client.call({ method: 'unsubscribe', session: this.id });
      } catch {
        /* disconnected/disposed */
      }
    }
  }
}
