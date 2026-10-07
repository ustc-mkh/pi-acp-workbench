import type { Snapshot } from './shared';
import type { SnapshotStore } from './snapshots';

/** Serialize storage operations and invalidate saves when local persistence is disabled. */
export class HistoryPersistence {
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  get pending() {
    return this.tail;
  }
  get epoch() {
    return this.version;
  }

  constructor(
    private store: SnapshotStore,
    private shared: boolean,
  ) {}

  invalidate() {
    this.version++;
  }

  enqueue(operation: () => Promise<void>) {
    this.tail = this.tail.catch(() => {}).then(operation);
    return this.tail;
  }

  /** Call inside enqueue, alongside the associated index updates. */
  async write(snapshot: Snapshot, epoch: number, retained: () => boolean) {
    const current = () => epoch === this.epoch && retained();
    if (!current()) return;
    const index = await this.store.write(snapshot);
    if (current()) return index;

    // Shared writes already committed to the server belong to every client.
    // A local preference change must never create a server-wide tombstone.
    // Explicit deletion remains a separate queued operation.
    if (!this.shared) await this.store.remove(index.id);
  }
}
