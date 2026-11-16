import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ContentVerifier, readContent } from '../src/workbench-content';
import { contentRef, type ContentSlice } from '../src/workbench-protocol';
import type { WorkbenchClient } from '../src/workbench-client';

function fixture(text = '你好 world') {
  const ref = contentRef.parse({
    id: 'content-1',
    kind: 'Text',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  const slice = (text: string, next_offset: number | null): ContentSlice => ({
    text,
    next_offset,
    sha256: ref.sha256,
    total_bytes: ref.bytes,
  });
  return { ref, slice };
}

it('verifies UTF-8 byte offsets across chunks and rejects incomplete or corrupt final text', () => {
  const { ref, slice } = fixture();
  const verifier = new ContentVerifier(ref);
  expect(verifier.append(slice('你好', 6))).toBe(false);
  expect(verifier.offset).toBe(6);
  expect(verifier.append(slice(' world', null))).toBe(true);
  expect(() => new ContentVerifier(ref).append(slice('你好', null))).toThrow(/checksum/);
  expect(() => new ContentVerifier(ref).append(slice('你好 worle', null))).toThrow(/checksum/);
});

it('rejects changed identity, inconsistent totals and stalled or skipped cursors', () => {
  const { ref, slice } = fixture();
  for (const page of [
    { ...slice('你好', 6), sha256: '0'.repeat(64) },
    { ...slice('你好', 6), total_bytes: ref.bytes + 1 },
    slice('', 0),
    slice('你好', 7),
    slice('你好 world!', null),
  ])
    expect(() => new ContentVerifier(ref).append(page)).toThrow();
  const empty = fixture('');
  expect(new ContentVerifier(empty.ref).append(empty.slice('', null))).toBe(true);
});

it('checks cancellation after a response before exposing its contents', async () => {
  const { ref, slice } = fixture();
  let valid = true;
  const client = {
    call: async () => {
      valid = false;
      return slice('你好 world', null);
    },
  } as unknown as Pick<WorkbenchClient, 'call'>;
  const stream = readContent(client, ref, () => {
    if (!valid) throw new Error('Session changed');
  });
  await expect(stream.next()).rejects.toThrow('Session changed');
});
