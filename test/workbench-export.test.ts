import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { exportMarkdown } from '../src/workbench-export';
import type { WorkbenchClient } from '../src/workbench-client';
import { contentRef, entryHeader, sessionId } from '../src/workbench-protocol';

const session = sessionId.parse('export-session');
const entry = (seq: number) =>
  entryHeader.parse({
    seq,
    id: `entry-${seq}`,
    turn: 'turn',
    role: 'Agent',
    message: null,
    text: { Inline: { text: `message-${seq}` } },
    image: null,
  });
async function collect(chunks: AsyncIterable<string>) {
  let output = '';
  for await (const text of chunks) output += text;
  return output;
}
it('exports more than the UI window chronologically using bounded pages and verified content slices', async () => {
  const long = '中文🌏'.repeat(14000);
  const bytes = Buffer.from(long);
  const ref = contentRef.parse({
    id: 'long',
    kind: 'Text',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const methods: string[] = [];
  const client = {
    call: async (command: any) => {
      methods.push(command.method);
      if (command.method === 'history') {
        const before = command.cursor?.before_seq ?? 306;
        const from = Math.max(1, before - 100);
        const entries = Array.from({ length: before - from }, (_, i) => entry(from + i));
        for (const row of entries) if (row.seq === 150) row.text = { Archived: { content: ref } };
        return {
          entries,
          next_cursor:
            from === 1 ? null : { version: 3, session, max_entry_seq: 305, before_seq: from },
        };
      }
      if (command.method === 'content') {
        // Slice bytes on Unicode boundaries while forcing several bounded chunks.
        let end = Math.min(bytes.length, command.offset + 63000);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        return {
          text: bytes.subarray(command.offset, end).toString('utf8'),
          next_offset: end === bytes.length ? null : end,
          total_bytes: bytes.length,
          sha256: ref.sha256,
        };
      }
      throw new Error('Unexpected mutation');
    },
  } as unknown as Pick<WorkbenchClient, 'call'>;
  const output = await collect(exportMarkdown(client, session));
  expect(output).toContain(long);
  expect(output.indexOf('## 1 ·')).toBeLessThan(output.indexOf('## 150 ·'));
  expect(output.indexOf('## 150 ·')).toBeLessThan(output.indexOf('## 305 ·'));
  expect(output.match(/^## /gm)).toHaveLength(305);
  expect(methods.filter((method) => method === 'history')).toHaveLength(4);
  expect(new Set(methods)).toEqual(new Set(['history', 'content']));
});
it('aborts on repeated history cursors rather than looping or duplicating output', async () => {
  const client = {
    call: async () => ({
      entries: [entry(2)],
      next_cursor: { version: 3, session, max_entry_seq: 2, before_seq: 2 },
    }),
  } as unknown as Pick<WorkbenchClient, 'call'>;
  await expect(collect(exportMarkdown(client, session))).rejects.toThrow(/ordering|progress/);
});
it('checks authorization during streaming and stops without provider mutation', async () => {
  let calls = 0;
  const client = {
    call: async () => {
      calls++;
      return { entries: [entry(1)], next_cursor: null };
    },
  } as unknown as Pick<WorkbenchClient, 'call'>;
  let allowed = true;
  const chunks = exportMarkdown(client, session, () => {
    if (!allowed) throw new Error('trust revoked');
  });
  expect((await chunks.next()).value).toContain('# Session');
  allowed = false;
  await expect(chunks.next()).rejects.toThrow('trust revoked');
  expect(calls).toBe(1);
});
