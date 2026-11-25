import type { WorkbenchClient } from './workbench-client';
import {
  jsonBytes,
  MAX_HISTORY_TURNS,
  type EntryHeader,
  type HistoryCursor,
  type HistoryPage,
  type SessionId,
} from './workbench-protocol';

export const INITIAL_HISTORY_TURNS = 3;
export const EARLIER_HISTORY_TURNS = MAX_HISTORY_TURNS;
export const MAX_DISPLAY_ENTRIES = 20_000;
export const MAX_DISPLAY_BYTES = 8 * 1024 * 1024;
export function historyFits(entries: readonly EntryHeader[]) {
  return entries.length <= MAX_DISPLAY_ENTRIES && jsonBytes(entries) <= MAX_DISPLAY_BYTES;
}

export function boundRecentHistory(entries: EntryHeader[]) {
  let bytes = jsonBytes(entries);
  let start = 0;
  while (entries.length - start > MAX_DISPLAY_ENTRIES || bytes > MAX_DISPLAY_BYTES) {
    bytes -= jsonBytes(entries[start]) + 1;
    start++;
  }
  if (!start) return { entries, partial: false };
  if (entries[start]?.turn === entries[start - 1].turn) {
    const firstTurn = entries[start].turn;
    const next = entries.findIndex((entry, i) => i > start && entry.turn !== firstTurn);
    if (next < 0) {
      // Leave room for further output while the oversized turn is still streaming.
      return { entries: entries.slice(Math.max(start, entries.length - 200)), partial: true };
    }
    start = next;
  }
  return { entries: entries.slice(start), partial: false };
}

export function validateHistoryPage(
  page: HistoryPage,
  cursor: HistoryCursor,
  session: SessionId,
  maxEntrySeq: number,
) {
  const { entries, next_cursor: next } = page;
  if (
    entries.some(
      (row, i) => row.seq >= cursor.before_seq || (i > 0 && row.seq <= entries[i - 1].seq),
    ) ||
    (next &&
      (next.session !== session ||
        next.max_entry_seq !== maxEntrySeq ||
        next.before_seq !== entries[0]?.seq))
  )
    throw new Error('历史分页未向前推进，请重新加载会话。');
}

/** Assemble complete turn boundaries over bounded, immutable high-water pages.
 * One extra older turn proves the oldest requested turn is complete. */
export async function loadHistoryTurns(
  client: Pick<WorkbenchClient, 'call'>,
  session: SessionId,
  initial: HistoryPage,
  maxEntrySeq: number,
  turns: number,
  valid: () => boolean,
): Promise<(HistoryPage & { truncated: boolean }) | undefined> {
  let entries = initial.entries,
    cursor = initial.next_cursor;
  let bytes = jsonBytes(entries);
  for (let pages = 0; ; pages++) {
    if (!valid()) return;
    const seen = new Set<string>();
    let start = 0,
      boundary = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      seen.add(entries[i].turn);
      if (seen.size > turns) {
        start = i + 1;
        boundary = true;
        break;
      }
    }
    const limit = pages >= 100 || entries.length > MAX_DISPLAY_ENTRIES || bytes > MAX_DISPLAY_BYTES;
    if (boundary || !cursor || limit) {
      const selected = boundRecentHistory(entries.slice(start)).entries;
      return {
        entries: selected,
        truncated:
          selected.length < entries.length - start || (!boundary && Boolean(cursor) && limit),
        next_cursor:
          selected.length && selected.length < entries.length
            ? {
                version: 3,
                session,
                max_entry_seq: maxEntrySeq,
                before_seq: selected[0].seq,
              }
            : cursor,
      };
    }
    const page = await client.call({ method: 'history', session, cursor, limit: 200 });
    if (!valid()) return;
    validateHistoryPage(page, cursor, session, maxEntrySeq);
    // Merging two nonempty JSON arrays removes two brackets and adds a comma.
    if (page.entries.length) bytes += jsonBytes(page.entries) - (entries.length ? 1 : 2);
    entries = [...page.entries, ...entries];
    cursor = page.next_cursor;
  }
}
