/** In-memory LRU of idle connections. No cache files survive an extension-host restart. */
export class SessionCache<T extends { agent: { dispose(): void; isClosed: boolean } }> {
  private items = new Map<string, { value: T; bytes: number }>();
  constructor(
    private maxCount = 2,
    private maxBytes = 32 * 1024 * 1024,
  ) {}
  take(id: string): T | undefined {
    const item = this.items.get(id);
    this.items.delete(id);
    if (!item) return;
    if (item.value.agent.isClosed) {
      item.value.agent.dispose();
      return;
    }
    return item.value;
  }
  get(id: string) {
    return this.items.get(id)?.value;
  }
  find(agent: T['agent']) {
    return [...this.items.entries()].find(([, item]) => item.value.agent === agent)?.[0];
  }
  put(id: string, value: T, bytes: number) {
    this.remove(id);
    if (value.agent.isClosed || bytes > this.maxBytes) {
      value.agent.dispose();
      return;
    }
    this.items.set(id, { value, bytes });
    while (this.items.size > this.maxCount || this.sizeBytes > this.maxBytes)
      this.remove(this.items.keys().next().value!);
  }
  remove(id: string) {
    const item = this.items.get(id);
    this.items.delete(id);
    item?.value.agent.dispose();
  }
  clear() {
    for (const id of this.items.keys()) this.remove(id);
  }
  get size() {
    return this.items.size;
  }
  private get sizeBytes() {
    return [...this.items.values()].reduce((sum, item) => sum + item.bytes, 0);
  }
}
