import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import type { ContentRef, HistoryCursor, SessionId } from './workbench-protocol';

/** Cold, query-only export. Pages arrive newest first; spool offsets on disk so
 * chronological output never needs the full transcript or all cursors in RAM. */
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
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const [body, index] = handles;
  let position = 0,
    pages = 0;
  const append = async (text: string) => {
    guard();
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = await body.write(bytes, offset, bytes.length - offset, position);
      if (!written.bytesWritten) throw new Error('Export write made no progress');
      offset += written.bytesWritten;
      position += written.bytesWritten;
    }
  };
  const content = async (ref: ContentRef) => {
    let offset = 0;
    const hash = createHash('sha256');
    for (;;) {
      guard();
      const slice = await client.call({ method: 'content', ref, offset });
      guard();
      const bytes = Buffer.from(slice.text);
      if (slice.sha256 !== ref.sha256 || slice.total_bytes !== ref.bytes)
        throw new Error('Export content identity changed');
      hash.update(bytes);
      await append(slice.text);
      if (slice.next_offset === null) {
        if (offset + bytes.length !== ref.bytes || hash.digest('hex') !== ref.sha256)
          throw new Error('Export content checksum mismatch');
        break;
      }
      if (slice.next_offset !== offset + bytes.length || slice.next_offset <= offset)
        throw new Error('Export content cursor made no progress');
      offset = slice.next_offset;
    }
  };
  try {
    let cursor: HistoryCursor | undefined;
    let previousFirst = Number.MAX_SAFE_INTEGER;
    for (;;) {
      guard();
      const page = await client.call({ method: 'history', session, cursor, limit: 100 });
      guard();
      const start = position;
      let previous = 0;
      for (const entry of page.entries) {
        if (entry.seq <= previous || entry.seq >= previousFirst)
          throw new Error('Export history ordering changed');
        previous = entry.seq;
        await append(`## ${entry.seq} · ${entry.role}\n\n`);
        if ('Inline' in entry.text) await append(entry.text.Inline.text);
        else await content(entry.text.Archived.content);
        if (entry.image)
          await append(
            `\n\n[Archived image: ${entry.image.mime}; ${entry.image.bytes} bytes; ${entry.image.sha256}]`,
          );
        await append('\n\n');
      }
      const record = Buffer.alloc(16);
      record.writeBigUInt64LE(BigInt(start), 0);
      record.writeBigUInt64LE(BigInt(position - start), 8);
      if ((await index.write(record, 0, 16, pages * 16)).bytesWritten !== 16)
        throw new Error('Export index write truncated');
      pages++;
      if (!page.next_cursor) break;
      if (!page.entries.length || (cursor && page.next_cursor.before_seq >= cursor.before_seq))
        throw new Error('Export history cursor made no progress');
      previousFirst = page.entries[0].seq;
      cursor = page.next_cursor;
    }
    yield `# Session ${session}\n\nChronological committed transcript. Images are immutable archive descriptors, not external links.\n\n`;
    const buffer = Buffer.alloc(64 * 1024);
    for (let page = pages - 1; page >= 0; page--) {
      guard();
      const record = Buffer.alloc(16);
      if ((await index.read(record, 0, 16, page * 16)).bytesRead !== 16)
        throw new Error('Export index truncated');
      let offset = Number(record.readBigUInt64LE(0));
      let remaining = Number(record.readBigUInt64LE(8));
      // Decode each page incrementally so UTF-8 split across reads is preserved.
      const decoder = new TextDecoder();
      while (remaining) {
        guard();
        const { bytesRead } = await body.read(
          buffer,
          0,
          Math.min(remaining, buffer.length),
          offset,
        );
        if (!bytesRead) throw new Error('Export spool truncated');
        yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        offset += bytesRead;
        remaining -= bytesRead;
      }
      yield decoder.decode();
    }
  } finally {
    try {
      await Promise.all([body.close(), index.close()]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
