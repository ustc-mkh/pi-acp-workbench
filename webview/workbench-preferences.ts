/** Bounded display preferences only; never persist host state or commands. */
const MAX_DISCLOSURES = 256;
export class Preferences {
  showThoughts = true;
  historyOpen = false;
  activityExpanded = false;
  harness = 'Pi';
  lastSessions: Partial<Record<string, string>> = {};
  autoScroll = true;
  sessionRows = 4;
  composerHeight = 80;
  private disclosures = new Map<string, boolean>();
  constructor(saved?: unknown) {
    if (!saved || typeof saved !== 'object' || !('preferences' in saved)) return;
    const value = saved.preferences;
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of ['historyOpen', 'activityExpanded'] as const)
      if (typeof record[key] === 'boolean') this[key] = record[key];
    if ('harness' in value && ['Pi', 'Codex', 'Claude'].includes(String(value.harness)))
      this.harness = String(value.harness);
    if ('lastSessions' in value && value.lastSessions && typeof value.lastSessions === 'object')
      for (const name of ['Pi', 'Codex', 'Claude']) {
        const id = (value.lastSessions as Record<string, unknown>)[name];
        if (typeof id === 'string' && id.length <= 1000) this.lastSessions[name] = id;
      }
    if ('showThoughts' in value && typeof value.showThoughts === 'boolean')
      this.showThoughts = value.showThoughts;
    if ('autoScroll' in value && typeof value.autoScroll === 'boolean')
      this.autoScroll = value.autoScroll;
    if (
      'sessionRows' in value &&
      Number.isInteger(value.sessionRows) &&
      Number(value.sessionRows) >= 1 &&
      [4, 10, 16].includes(Number(value.sessionRows))
    )
      this.sessionRows = Number(value.sessionRows);
    if (
      'composerHeight' in value &&
      typeof value.composerHeight === 'number' &&
      Number.isFinite(value.composerHeight)
    )
      this.composerHeight = Math.max(65, Math.min(1000, value.composerHeight));
    if (record.layoutRevision !== 2 && this.composerHeight === 100) this.composerHeight = 80;
    if ('disclosures' in value && Array.isArray(value.disclosures))
      for (const row of value.disclosures.slice(-MAX_DISCLOSURES))
        if (
          Array.isArray(row) &&
          row.length === 2 &&
          typeof row[0] === 'string' &&
          row[0].length <= 1024 &&
          typeof row[1] === 'boolean'
        )
          this.disclosures.set(row[0], row[1]);
  }
  open(key: string, fallback: boolean) {
    return this.disclosures.get(key) ?? fallback;
  }
  setOpen(key: string, open: boolean) {
    if (key.length > 1024) return;
    this.disclosures.delete(key);
    this.disclosures.set(key, open);
    while (this.disclosures.size > MAX_DISCLOSURES)
      this.disclosures.delete(this.disclosures.keys().next().value!);
  }
  snapshot() {
    return {
      preferences: {
        layoutRevision: 2,
        showThoughts: this.showThoughts,
        historyOpen: this.historyOpen,
        activityExpanded: this.activityExpanded,
        harness: this.harness,
        lastSessions: { ...this.lastSessions },
        autoScroll: this.autoScroll,
        sessionRows: this.sessionRows,
        composerHeight: this.composerHeight,
        disclosures: [...this.disclosures],
      },
    };
  }
}
