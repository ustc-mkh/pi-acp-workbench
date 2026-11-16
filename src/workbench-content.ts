import { createHash } from 'node:crypto';
import type { WorkbenchClient } from './workbench-client';
import type { ContentRef, ContentSlice } from './workbench-protocol';

/** Incremental verification shared by batch loading, copying and streaming export. */
export class ContentVerifier {
  offset = 0;
  private hash = createHash('sha256');
  constructor(readonly ref: ContentRef) {}

  append(slice: ContentSlice): boolean {
    const end = this.offset + Buffer.byteLength(slice.text);
    if (
      slice.sha256 !== this.ref.sha256 ||
      slice.total_bytes !== this.ref.bytes ||
      end > this.ref.bytes ||
      (slice.next_offset !== null && (slice.next_offset !== end || end <= this.offset))
    )
      throw new Error('Invalid archived text identity or cursor');
    this.hash.update(slice.text);
    this.offset = end;
    if (slice.next_offset !== null) return false;
    if (end !== this.ref.bytes || this.hash.digest('hex') !== this.ref.sha256)
      throw new Error('Archived text checksum mismatch');
    return true;
  }
}

export async function* readContent(
  client: Pick<WorkbenchClient, 'call'>,
  ref: ContentRef,
  guard: () => void,
): AsyncGenerator<string> {
  const verifier = new ContentVerifier(ref);
  for (;;) {
    guard();
    const slice = await client.call({ method: 'content', ref, offset: verifier.offset });
    guard();
    const complete = verifier.append(slice);
    yield slice.text;
    if (complete) return;
  }
}
