/** Catalogue patches are transport-neutral UI merge helpers. Omission means unknown; explicit empty live lists clear. */
export function mergeCatalogue<T extends object>(
  previous: T | undefined,
  next: T | null | undefined,
  phase: 'live' | 'cold' = 'live',
): T | undefined {
  if (next == null) return previous;
  if (phase === 'cold' && Object.keys(next).length === 0) return previous;
  return next;
}
