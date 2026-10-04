/** Per-session ordering plus a global concurrency budget. No process or storage ownership. */
export class TaskQueue {
  private tails = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  private waiters: (() => void)[] = [];
  private active = 0;
  private queued = 0;
  private closed = false;
  constructor(private capacity: number, private limit = 100) {}
  get pendingCount() { return this.queued; }
  cancel(id: string) {
    if (this.tails.has(id)) this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
  }
  async run<T>(id: string, operation: (check: () => void) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('会话服务正在停止');
    if (this.queued >= this.limit) throw new Error('服务排队已满');
    this.queued++;
    const epoch = this.epochs.get(id) || 0;
    const check = () => {
      if (this.closed || epoch !== (this.epochs.get(id) || 0)) throw new Error('排队请求已取消');
    };
    const task = (this.tails.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.active >= this.capacity) await new Promise<void>(resolve => this.waiters.push(resolve));
      else this.active++;
      try { check(); return await operation(check); }
      finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
    });
    this.tails.set(id, task);
    try { return await task; }
    finally {
      this.queued--;
      if (this.tails.get(id) === task) { this.tails.delete(id); this.epochs.delete(id); }
    }
  }
  /** Active owners must stop their processes before awaiting this drain. */
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.tails.values()]);
  }
}
