import { expect, it, vi } from 'vitest';
import { mergeTranscript } from '../src/transcript-window';
import { loadEarlier } from '../src/conversation-transcript';
import { initialState } from '../src/state';
import type { Entry } from '../src/shared';
const entries = (start: number, end: number): Entry[] =>
  Array.from({ length: end - start }, (_, i) => ({
    id: String(start + i),
    role: 'user',
    text: String(i),
  }));
it('keeps loaded pages and advances the live tail without duplicates', () => {
  const merged = mergeTranscript(entries(100, 300), entries(201, 301), 100, 201);
  expect(merged.before).toBe(100);
  expect(merged.entries).toHaveLength(201);
  expect(new Set(merged.entries.map((e) => e.id)).size).toBe(201);
  expect(mergeTranscript(entries(100, 300), entries(400, 500), 100, 400)).toEqual({
    entries: entries(400, 500),
    before: 400,
  });
});
it('prepends explicit pages and ignores a late reply after switching sessions', async () => {
  const call = vi.fn().mockResolvedValue({ entries: entries(100, 200), remaining: 100 });
  const host = {
    state: { ...initialState(), sessionId: 'one', entries: entries(200, 300), historyBefore: 200 },
    generation: 1,
    serviceClient: { call },
    emit: vi.fn(),
  };
  await loadEarlier(host, 'one');
  expect(host.state.entries).toHaveLength(200);
  expect(host.state.historyBefore).toBe(100);
  call.mockImplementation(async () => {
    host.generation++;
    return { entries: entries(0, 100), remaining: 0 };
  });
  await loadEarlier(host, 'one');
  expect(host.state.historyBefore).toBe(100);
  expect(host.emit).toHaveBeenCalledTimes(1);
});
