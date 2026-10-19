/** Bounded display preferences only; never persist host state or commands. */
const MAX_DISCLOSURES = 256;
export class Preferences {
  showThoughts = true;
  private disclosures = new Map<string, boolean>();
  constructor(saved?: unknown) {
    if (!saved || typeof saved !== 'object' || !('preferences' in saved)) return;
    const value = saved.preferences;
    if (!value || typeof value !== 'object') return;
    if ('showThoughts' in value && typeof value.showThoughts === 'boolean')
      this.showThoughts = value.showThoughts;
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
    return { preferences: { showThoughts: this.showThoughts, disclosures: [...this.disclosures] } };
  }
}
