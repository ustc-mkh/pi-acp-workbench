/** Client-only preferences. Never persist domain state or replayable commands. */
export const MAX_DRAFTS = 16;
export const MAX_DRAFT_CHARS = 200000;
export const MAX_TOTAL_DRAFT_CHARS = 512000;
export class Drafts {
  private values = new Map<string, string>();
  constructor(saved?: unknown) {
    if (!saved || typeof saved !== 'object' || !('drafts' in saved)) return;
    const entries = saved.drafts;
    if (!Array.isArray(entries) || entries.length > MAX_DRAFTS) return;
    for (const entry of entries) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        entry[0].length <= 256 &&
        typeof entry[1] === 'string' &&
        entry[1].length <= MAX_DRAFT_CHARS
      )
        this.set(entry[0], entry[1]);
    }
  }
  get(session: string) {
    return this.values.get(session) ?? '';
  }
  set(session: string, text: string) {
    if (session.length > 256 || text.length > MAX_DRAFT_CHARS) return;
    this.values.delete(session);
    if (text) this.values.set(session, text);
    let total = [...this.values.values()].reduce((sum, value) => sum + value.length, 0);
    while (this.values.size > MAX_DRAFTS || total > MAX_TOTAL_DRAFT_CHARS) {
      const first = this.values.keys().next().value!;
      total -= this.values.get(first)!.length;
      this.values.delete(first);
    }
  }
  snapshot() {
    return { drafts: [...this.values.entries()] };
  }
}
