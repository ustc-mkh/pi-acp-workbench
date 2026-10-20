import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import type { ContentRef, EntryHeader, HistoryCursor, SessionId } from './workbench-protocol';
import { continuesMessage } from './workbench-messages';

/** Reverse cold pages on disk, then stream chronological logical messages.
 * Identity is carried across page boundaries; archive bodies never accumulate. */
export async function* exportMarkdown(
  client: Pick<WorkbenchClient, 'call'>,
  session: SessionId,
  guard: () => void = () => {},
): AsyncGenerator<string> {
  guard();
  const directory = await mkdtemp(join(tmpdir(), 'workbench-export-'));
  const handles = [];
  try {
    handles.push(await open(join(directory, 'body'), 'wx+', 0o600));
    handles.push(await open(join(directory, 'index'), 'wx+', 0o600));
    const [body, index] = handles;
    let position = 0,
      pages = 0,
      cursor: HistoryCursor | undefined;
    let previousFirst = Number.MAX_SAFE_INTEGER;
    for (;;) {
      guard();
      const page = await client.call({ method: 'history', session, cursor, limit: 100 });
      guard();
      let previous = 0;
      for (const entry of page.entries) {
        if (entry.seq <= previous || entry.seq >= previousFirst)
          throw new Error('Export history ordering changed');
        previous = entry.seq;
      }
      const bytes = Buffer.from(JSON.stringify(page.entries));
      let offset = 0;
      while (offset < bytes.length) {
        const written = await body.write(bytes, offset, bytes.length - offset, position + offset);
        if (!written.bytesWritten) throw new Error('Export write made no progress');
        offset += written.bytesWritten;
      }
      const record = Buffer.alloc(16);
      record.writeBigUInt64LE(BigInt(position), 0);
      record.writeBigUInt64LE(BigInt(bytes.length), 8);
      if ((await index.write(record, 0, 16, pages * 16)).bytesWritten !== 16)
        throw new Error('Export index write truncated');
      pages++;
      position += bytes.length;
      if (!page.next_cursor) break;
      if (!page.entries.length || (cursor && page.next_cursor.before_seq >= cursor.before_seq))
        throw new Error('Export history cursor made no progress');
      previousFirst = page.entries[0].seq;
      cursor = page.next_cursor;
    }
    async function* content(ref: ContentRef) {
      let offset = 0;
      const hash = createHash('sha256');
      for (;;) {
        guard();
        const slice = await client.call({ method: 'content', ref, offset });
        guard();
        const end = offset + Buffer.byteLength(slice.text);
        if (slice.sha256 !== ref.sha256 || slice.total_bytes !== ref.bytes || end > ref.bytes)
          throw new Error('Export content identity changed');
        hash.update(slice.text);
        yield slice.text;
        if (slice.next_offset === null) {
          if (end !== ref.bytes || hash.digest('hex') !== ref.sha256)
            throw new Error('Export content checksum mismatch');
          break;
        }
        if (slice.next_offset !== end || end <= offset)
          throw new Error('Export content cursor made no progress');
        offset = end;
      }
    }
    yield `# Session ${session}\n\nChronological committed transcript. Images are immutable archive descriptors, not external links.\n\n`;
    let previous: EntryHeader | undefined;
    for (let page = pages - 1; page >= 0; page--) {
      guard();
      const record = Buffer.alloc(16);
      if ((await index.read(record, 0, 16, page * 16)).bytesRead !== 16)
        throw new Error('Export index truncated');
      const start = Number(record.readBigUInt64LE(0)),
        length = Number(record.readBigUInt64LE(8));
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await body.read(bytes, read, length - read, start + read);
        if (!bytesRead) throw new Error('Export spool truncated');
        read += bytesRead;
      }
      const entries: EntryHeader[] = JSON.parse(bytes.toString('utf8'));
      for (const entry of entries) {
        guard();
        if (!previous || !continuesMessage(previous, entry))
          yield `${previous ? '\n\n' : ''}## ${entry.seq} · ${entry.role}\n\n`;
        if ('Inline' in entry.text) yield entry.text.Inline.text;
        else yield* content(entry.text.Archived.content);
        if (entry.image)
          yield `\n\n[Archived image: ${entry.image.mime}; ${entry.image.bytes} bytes; ${entry.image.sha256}]`;
        previous = entry;
      }
    }
    yield '\n\n';
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
