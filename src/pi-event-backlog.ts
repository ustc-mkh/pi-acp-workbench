/** Preserve extension wakeups emitted while the RPC worker is being restored,
 * before the adapter attaches its session listener. Never silently drop a run. */
export class PiEventBacklog {
  private events: unknown[] = [];
  private bytes = 0;
  push(event: unknown) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (this.events.length >= 10000 || this.bytes + size > 4 * 1024 * 1024)
      throw new Error('Pi startup event backlog exceeded its limit.');
    this.events.push(event);
    this.bytes += size;
  }
  drain(handler: (event: unknown) => void) {
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    for (const event of events) handler(event);
  }
}
