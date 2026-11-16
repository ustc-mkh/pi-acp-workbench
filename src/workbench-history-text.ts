import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import {
  MAX_CONTENT_BATCH_ITEMS,
  type ContentRead,
  type ContentRef,
  type ContentSlice,
  type EntryHeader,
} from './workbench-protocol';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_ITEMS = 128;

interface PendingText {
  ref: ContentRef;
  offset: number;
  parts: string[];
}

function appendSlice(read: PendingText, page: ContentSlice) {
  const end = read.offset + Buffer.byteLength(page.text);
  if (
    page.sha256 !== read.ref.sha256 ||
    page.total_bytes !== read.ref.bytes ||
    end > read.ref.bytes ||
    (page.next_offset !== null && (page.next_offset !== end || end <= read.offset))
  )
    throw new Error('Invalid archived text slice');
  read.parts.push(page.text);
  read.offset = end;
  if (page.next_offset !== null) return;
  const text = read.parts.join('');
  if (end !== read.ref.bytes || createHash('sha256').update(text).digest('hex') !== read.ref.sha256)
    throw new Error('Incomplete archived text');
  return text;
}

/** A bounded per-session cache of verified immutable message text. */
export class HistoryText {
  private cache = new Map<string, { text: string; bytes: number }>();
  private failed = new Set<string>();
  private bytes = 0;

  snapshot(entries: readonly EntryHeader[]) {
    const resolved: Record<string, string> = Object.create(null);
    for (const row of entries) {
      if (!('Archived' in row.text)) continue;
      const ref = row.text.Archived.content;
      const cached = this.cache.get(ref.id);
      if (cached) resolved[ref.id] = cached.text;
    }
    return resolved;
  }

  async resolve(
    client: Pick<WorkbenchClient, 'call'>,
    entries: readonly EntryHeader[],
    valid: () => boolean,
    changed: () => void,
    wanted: (id: string) => boolean = () => true,
  ) {
    const pending = new Map<string, PendingText>();
    const seen = new Set<string>();
    let total = 0;
    for (const row of entries) {
      if (!('Archived' in row.text)) continue;
      const ref = row.text.Archived.content;
      if (this.failed.has(ref.id) || seen.has(ref.id)) continue;
      if (ref.bytes > MAX_TEXT || total + ref.bytes > MAX_TOTAL || seen.size >= MAX_ITEMS) continue;
      seen.add(ref.id);
      total += ref.bytes;
      const cached = this.cache.get(ref.id);
      if (cached) {
        this.cache.delete(ref.id);
        this.cache.set(ref.id, cached);
      } else pending.set(ref.id, { ref, offset: 0, parts: [] });
    }

    while (valid() && pending.size) {
      const reads: ContentRead[] = [];
      for (const { ref, offset } of pending.values()) {
        if (!wanted(ref.id)) {
          pending.delete(ref.id);
          continue;
        }
        reads.push({ ref, offset });
        if (reads.length === MAX_CONTENT_BATCH_ITEMS) break;
      }
      if (!reads.length) return;
      const { slices } = await client.call({ method: 'content_batch', reads }, { timeoutMs: 5000 });
      if (!valid()) return;
      if (!slices.length || slices.length > reads.length)
        throw new Error('Invalid archived text batch');
      let updated = false;
      for (const [i, page] of slices.entries()) {
        const id = reads[i].ref.id;
        const read = pending.get(id)!;
        try {
          if (!page) throw new Error('Unavailable archived text');
          const text = appendSlice(read, page);
          if (text === undefined) continue;
          this.remember(read.ref, text);
          updated = true;
        } catch {
          this.failed.add(id);
          while (this.failed.size > MAX_ITEMS)
            this.failed.delete(this.failed.values().next().value!);
        }
        pending.delete(id);
      }
      if (updated) changed();
    }
  }

  private remember(ref: ContentRef, text: string) {
    while (this.cache.size >= MAX_ITEMS || this.bytes + ref.bytes > MAX_TOTAL) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(ref.id, { text, bytes: ref.bytes });
    this.bytes += ref.bytes;
  }
}
