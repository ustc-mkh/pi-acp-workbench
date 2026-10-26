import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import type { ContentRef, EntryHeader } from './workbench-protocol';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
/** Read immutable archived message text in bounded slices, never tool/image data.
 * This cache belongs to one selected session and is not another history owner. */
export class HistoryText {
  private cache = new Map<string, { text: string; bytes: number }>();
  private failed = new Set<string>();
  private bytes = 0;
  async resolve(
    client: Pick<WorkbenchClient, 'call'>,
    entries: readonly EntryHeader[],
    valid: () => boolean,
  ) {
    const refs = new Map<string, ContentRef>();
    let total = 0;
    for (const row of [...entries].reverse()) {
      if (!('Archived' in row.text)) continue;
      const ref = row.text.Archived.content;
      if (
        refs.has(ref.id) ||
        ref.bytes > MAX_TEXT ||
        total + ref.bytes > MAX_TOTAL ||
        refs.size >= 128
      )
        continue;
      refs.set(ref.id, ref);
      total += ref.bytes;
    }
    const resolved: Record<string, string> = {};
    for (const ref of refs.values()) {
      if (!valid()) return;
      let cached = this.cache.get(ref.id);
      if (!cached && !this.failed.has(ref.id)) {
        try {
          let offset = 0,
            text = '';
          for (;;) {
            if (!valid()) return;
            const page = await client.call({ method: 'content', ref, offset });
            if (!valid()) return;
            const end = offset + Buffer.byteLength(page.text);
            if (
              page.sha256 !== ref.sha256 ||
              page.total_bytes !== ref.bytes ||
              end > ref.bytes ||
              (page.next_offset !== null && (page.next_offset !== end || end <= offset))
            )
              throw new Error('Invalid archived text slice');
            text += page.text;
            if (page.next_offset === null) {
              if (
                end !== ref.bytes ||
                createHash('sha256').update(text).digest('hex') !== ref.sha256
              )
                throw new Error('Incomplete archived text');
              break;
            }
            offset = page.next_offset;
          }
          while (this.cache.size >= 128 || this.bytes + ref.bytes > MAX_TOTAL) {
            const oldest = this.cache.keys().next().value;
            if (!oldest) break;
            this.bytes -= this.cache.get(oldest)!.bytes;
            this.cache.delete(oldest);
          }
          cached = { text, bytes: ref.bytes };
          this.cache.set(ref.id, cached);
          this.bytes += ref.bytes;
        } catch {
          if (!valid()) return;
          this.failed.add(ref.id);
          while (this.failed.size > 128) this.failed.delete(this.failed.values().next().value!);
        }
      }
      if (cached) resolved[ref.id] = cached.text;
    }
    return resolved;
  }
}
