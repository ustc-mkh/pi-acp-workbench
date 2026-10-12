/** Omission means unknown. Only cold handshakes treat an empty catalogue as unknown;
 * live responses/updates may explicitly clear it. Keep this policy in sync with
 * rust/crates/pi-acp-session-daemon/src/catalogue.rs.
 */
export function mergeCatalogue<T extends object>(
  previous: T | undefined,
  next: T | null | undefined,
  phase: 'live' | 'cold' = 'live',
): T | undefined {
  if (next == null) return previous;
  if (phase === 'cold' && Object.keys(next).length === 0) return previous;
  return next;
}
