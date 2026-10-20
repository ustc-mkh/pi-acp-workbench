import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import type { EntryHeader, EntryId, HistoryCursor, SessionId } from './workbench-protocol';
import { continuesMessage } from './workbench-messages';

/** Cold pages, including both sides of a UI page boundary; bounded clipboard data. */
export async function copyLogicalMessage(
  client: Pick<WorkbenchClient, 'call'>,
  session: SessionId,
  target: EntryId,
  guard: () => void,
  standalone?: EntryHeader,
): Promise<string> {
  let cursor: HistoryCursor | undefined;
  let group: EntryHeader[] = [],
    previous: EntryHeader | undefined;
  let found = false,
    bytes = 0;
  const budget = 1024 * 1024;
  outer: for (;;) {
    guard();
    if (standalone) {
      group = [standalone];
      found = true;
      break;
    }
    const page = await client.call({ method: 'history', session, cursor, limit: 200 });
    guard();
    for (const entry of [...page.entries].reverse()) {
      if (previous && !continuesMessage(entry, previous)) {
        if (found) break outer;
        group = [];
        bytes = 0;
      }
      found ||= entry.id === target;
      bytes +=
        'Inline' in entry.text
          ? Buffer.byteLength(entry.text.Inline.text)
          : entry.text.Archived.content.bytes;
      if (bytes <= budget) group.push(entry);
      if (found && bytes > budget)
        throw new Error('Message exceeds clipboard budget; use full Markdown export');
      previous = entry;
    }
    if (!page.next_cursor) break;
    if (!page.entries.length || (cursor && page.next_cursor.before_seq >= cursor.before_seq))
      throw new Error('History cursor made no progress');
    cursor = page.next_cursor;
  }
  if (!found) throw new Error('Message is no longer available');
  if (
    group.reduce(
      (total, entry) =>
        total +
        ('Inline' in entry.text
          ? Buffer.byteLength(entry.text.Inline.text)
          : entry.text.Archived.content.bytes),
      0,
    ) > budget
  )
    throw new Error('Message exceeds clipboard budget; use full Markdown export');
  let text = '';
  for (const entry of group.reverse()) {
    guard();
    if ('Inline' in entry.text) text += entry.text.Inline.text;
    else {
      const ref = entry.text.Archived.content,
        hash = createHash('sha256');
      let offset = 0;
      for (;;) {
        const slice = await client.call({ method: 'content', ref, offset });
        guard();
        const end = offset + Buffer.byteLength(slice.text);
        if (
          slice.sha256 !== ref.sha256 ||
          slice.total_bytes !== ref.bytes ||
          end > ref.bytes ||
          (slice.next_offset !== null && slice.next_offset !== end)
        )
          throw new Error('Message identity or content cursor changed');
        hash.update(slice.text);
        text += slice.text;
        if (slice.next_offset === null) {
          if (end !== ref.bytes || hash.digest('hex') !== ref.sha256)
            throw new Error('Message checksum mismatch');
          break;
        }
        if (slice.next_offset <= offset) throw new Error('Message cursor made no progress');
        offset = slice.next_offset;
      }
    }
    if (entry.image)
      text += `${text ? '\n\n' : ''}[Archived image: ${entry.image.id}; ${entry.image.mime}; ${entry.image.bytes} bytes; ${entry.image.sha256}]`;
  }
  return text;
}
