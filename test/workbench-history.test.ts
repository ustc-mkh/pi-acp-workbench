import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadHistoryTurns } from '../src/workbench-history';
import { HistoryText } from '../src/workbench-history-text';
import {
  entryHeader,
  sessionId,
  type ContentRef,
  type HistoryCursor,
} from '../src/workbench-protocol';
import type { WorkbenchClient } from '../src/workbench-client';
const session = sessionId.parse('history');
it('loads complete last three turns across fragment pages, then twenty older turns without gaps or duplicates', async () => {
  const rows = Array.from({ length: 28 }, (_, turn) =>
    Array.from({ length: turn === 27 ? 350 : 5 }, () => turn),
  )
    .flat()
    .map((turn, i) =>
      entryHeader.parse({
        seq: i + 1,
        id: 'e' + i,
        turn: 't' + turn,
        role: 'Agent',
        message: 'm' + turn,
        image: null,
        text: { Inline: { text: i % 2 ? 'x' : '$$' } },
      }),
    );
  const high = rows.at(-1)!.seq,
    calls: HistoryCursor[] = [];
  const client = {
    call: async (q: { cursor: HistoryCursor }) => {
      calls.push(q.cursor);
      const page = rows
        .filter((r) => r.seq < q.cursor.before_seq && r.seq <= q.cursor.max_entry_seq)
        .slice(-200);
      return {
        entries: page,
        next_cursor: page[0]?.seq > 1 ? { ...q.cursor, before_seq: page[0].seq } : null,
      };
    },
  } as unknown as WorkbenchClient;
  const initial = await loadHistoryTurns(
    client,
    session,
    {
      entries: rows.slice(-100),
      next_cursor: { version: 3, session, max_entry_seq: high, before_seq: rows.at(-100)!.seq },
    },
    high,
    3,
    () => true,
  );
  expect(new Set(initial!.entries.map((r) => r.turn))).toEqual(new Set(['t25', 't26', 't27']));
  expect(initial!.entries).toEqual(rows.filter((r) => ['t25', 't26', 't27'].includes(r.turn)));
  const older = await loadHistoryTurns(
    client,
    session,
    { entries: [], next_cursor: initial!.next_cursor },
    high,
    20,
    () => true,
  );
  expect(new Set(older!.entries.map((r) => r.turn)).size).toBe(20);
  expect(older!.entries.at(-1)!.seq + 1).toBe(initial!.entries[0].seq);
  const first = await loadHistoryTurns(
    client,
    session,
    { entries: [], next_cursor: older!.next_cursor },
    high,
    20,
    () => true,
  );
  expect(first!.next_cursor).toBeNull();
  expect([...first!.entries, ...older!.entries, ...initial!.entries]).toEqual(rows);
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls.every((c) => c.max_entry_seq === high)).toBe(true);
});
it('fences stale history loading and rejects a non-progressing cursor', async () => {
  const cursor = { version: 3 as const, session, max_entry_seq: 10, before_seq: 5 };
  let valid = true;
  const client = {
    call: async () => {
      valid = false;
      return { entries: [], next_cursor: null };
    },
  } as unknown as WorkbenchClient;
  expect(
    await loadHistoryTurns(
      client,
      session,
      { entries: [], next_cursor: cursor },
      10,
      3,
      () => valid,
    ),
  ).toBeUndefined();
  const bad = {
    call: async () => ({ entries: [], next_cursor: cursor }),
  } as unknown as WorkbenchClient;
  await expect(
    loadHistoryTurns(bad, session, { entries: [], next_cursor: cursor }, 10, 3, () => true),
  ).rejects.toThrow('未向前推进');
});
it('joins UTF-8 archived slices and checks the whole text hash before displaying math', async () => {
  const text = '公式：\n$$\n\\sum_{i=1}^{n} i = n(n+1)/2\n$$\n' + '续'.repeat(24000);
  const bytes = Buffer.from(text),
    ref: ContentRef = {
      id: 'archive' as never,
      kind: 'Text',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const row = entryHeader.parse({
    seq: 1,
    id: 'math',
    turn: 't1',
    role: 'Agent',
    message: 'm',
    image: null,
    text: { Archived: { content: ref } },
  });
  let reads = 0;
  const client = {
    call: async (q: { offset: number }) => {
      reads++;
      let end = Math.min(bytes.length, q.offset + 60000);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      return {
        text: bytes.subarray(q.offset, end).toString(),
        total_bytes: bytes.length,
        sha256: ref.sha256,
        next_offset: end < bytes.length ? end : null,
      };
    },
  } as unknown as WorkbenchClient;
  const cache = new HistoryText();
  expect(await cache.resolve(client, [row], () => true)).toEqual({ archive: text });
  expect(reads).toBe(2);
  await cache.resolve(client, [row], () => true);
  expect(reads).toBe(2);
  const corrupt = {
    call: async () => ({
      text: 'wrong',
      total_bytes: ref.bytes,
      sha256: ref.sha256,
      next_offset: null,
    }),
  } as unknown as WorkbenchClient;
  expect(await new HistoryText().resolve(corrupt, [row], () => true)).toEqual({});
});
