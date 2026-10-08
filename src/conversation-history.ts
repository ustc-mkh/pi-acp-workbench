import type { Memento } from 'vscode';
import type { ChatState, Snapshot } from './shared';
import { HARNESS_IDS, harnessKey } from './harness';

/** Serialize client bookkeeping; the daemon owns all history writes and leases. */
export class ClientOperations {
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  get pending() {
    return this.tail;
  }
  get epoch() {
    return this.version;
  }
  invalidate() {
    this.version++;
  }
  enqueue(operation: () => Promise<void>) {
    this.tail = this.tail.catch(() => {}).then(operation);
    return this.tail;
  }
}
interface HistoryOptions {
  storage: Memento;
  enabled: () => boolean;
  current: () => ChatState;
  changed: () => void;
  error: (error: unknown) => void;
  remote: { list(): Promise<Snapshot[]>; remove(id?: string): Promise<unknown> };
}
/** Read-only client index and explicit remote deletion; no disk format or lock dependencies. */
export class ConversationHistory {
  items: Snapshot[] = [];
  readonly forgotten = new Set<string>();
  readonly persistence = new ClientOperations();
  ready: Promise<void> = Promise.resolve();
  private poll?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private backgroundError?: string;
  private disposed = false;
  constructor(private options: HistoryOptions) {}
  start() {
    this.initialize();
    this.poll = setInterval(() => {
      void this.refresh().catch((error) => this.reportBackgroundError(error));
    }, 5000);
    this.poll.unref();
  }
  initialize() {
    this.ready = this.ready
      .then(() => this.refreshOnce())
      .catch((error) => this.reportBackgroundError(error));
    return this.ready;
  }
  private reportBackgroundError(error: unknown) {
    if (this.disposed || !this.options.enabled()) return;
    const detail = String(error);
    if (this.backgroundError === detail) return;
    this.backgroundError = detail;
    this.options.error(error);
  }
  refresh(): Promise<void> {
    return (this.refreshing ||= this.ready
      .then(() => this.refreshOnce())
      .finally(() => {
        this.refreshing = undefined;
      }));
  }
  private async refreshOnce() {
    if (this.disposed || !this.options.enabled()) return;
    const epoch = this.persistence.epoch;
    const items = await this.options.remote.list();
    if (this.disposed || epoch !== this.persistence.epoch || !this.options.enabled()) return;
    const id = this.options.current().sessionId;
    if (id && this.items.some((s) => s.id === id) && !items.some((s) => s.id === id))
      this.forgotten.add(id);
    this.items = items;
    this.backgroundError = undefined;
    this.options.changed();
  }
  disable(after: () => Promise<void>) {
    this.persistence.invalidate();
    this.items = [];
    return this.persistence.enqueue(async () => {
      for (const harness of HARNESS_IDS)
        await this.options.storage.update(harnessKey('activeSession', harness), null);
      await after();
    });
  }
  remove(id: string | undefined, after: () => Promise<void>) {
    return this.persistence.enqueue(async () => {
      // Update the UI only after the daemon has acknowledged deletion.
      await this.options.remote.remove(id);
      this.persistence.invalidate();
      const removed = id ? this.items.filter((s) => s.id === id) : this.items;
      removed.forEach((s) => this.forgotten.add(s.id));
      const active = this.options.current().sessionId;
      if (!id && active) this.forgotten.add(active);
      this.items = id ? this.items.filter((s) => s.id !== id) : [];
      for (const harness of HARNESS_IDS) {
        const key = harnessKey('activeSession', harness);
        if (!id || this.options.storage.get(key) === id)
          await this.options.storage.update(key, null);
      }
      await after();
      this.options.changed();
    });
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.poll);
  }
}
