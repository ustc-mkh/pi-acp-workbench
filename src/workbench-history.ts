import type { WorkbenchClient } from './workbench-client';
import {
  jsonBytes,
  type EntryHeader,
  type HistoryPage,
  type SessionId,
} from './workbench-protocol';

export const INITIAL_HISTORY_TURNS = 3;
export const EARLIER_HISTORY_TURNS = 20;
export const MAX_DISPLAY_ENTRIES = 20_000;
export const MAX_DISPLAY_BYTES = 8 * 1024 * 1024;
export function historyFits(entries: readonly EntryHeader[]) {
  return entries.length <= MAX_DISPLAY_ENTRIES && jsonBytes(entries) <= MAX_DISPLAY_BYTES;
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
): Promise<HistoryPage | undefined> {
  let entries = [...initial.entries],
    cursor = initial.next_cursor;
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
    if (boundary || !cursor) {
      const selected = entries.slice(start);
      if (!historyFits(selected)) throw new Error('完整回合超出历史显示上限，请导出完整历史。');
      return {
        entries: selected,
        next_cursor:
          start > 0
            ? {
                version: 3,
                session,
                max_entry_seq: maxEntrySeq,
                before_seq: selected[0].seq,
              }
            : cursor,
      };
    }
    if (pages >= 100 || !historyFits(entries))
      throw new Error('完整回合超出历史显示上限，请导出完整历史。');
    const page = await client.call({ method: 'history', session, cursor, limit: 200 });
    if (!valid()) return;
    if (
      page.entries.some(
        (row, i) => row.seq >= cursor!.before_seq || (i > 0 && row.seq <= page.entries[i - 1].seq),
      ) ||
      (page.next_cursor &&
        (!page.entries.length ||
          page.next_cursor.before_seq >= cursor.before_seq ||
          page.next_cursor.session !== session ||
          page.next_cursor.max_entry_seq !== maxEntrySeq ||
          page.next_cursor.before_seq !== page.entries[0].seq))
    )
      throw new Error('历史分页未向前推进，请重新加载会话。');
    entries = [...page.entries, ...entries];
    cursor = page.next_cursor;
  }
}
