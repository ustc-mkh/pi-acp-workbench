import type { Entry } from './shared';

/** Retain explicitly loaded history while reconciling the daemon's live tail.
 * No overlap means reset (reconnect/replace), never guess or duplicate entries.
 */
export function mergeTranscript(
  previous: Entry[],
  incoming: Entry[],
  previousBefore: number | undefined,
  incomingBefore: number | undefined,
): { entries: Entry[]; before: number } {
  const before = incomingBefore ?? 0;
  if (before > 0 && incoming.length) {
    const overlap = previous.findIndex((entry) => entry.id === incoming[0].id);
    if (overlap >= 0 && (previousBefore ?? 0) + overlap === before)
      return { entries: [...previous.slice(0, overlap), ...incoming], before: previousBefore ?? 0 };
  }
  return { entries: incoming, before };
}
