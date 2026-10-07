import { it, expect } from 'vitest';
import { groupUsage, mergeUsage, priceFor, validPrice, type UsageRecord } from '../src/telemetry';
import { usageRecord } from '../src/pi-enhancements';
const r = (id: string, values: Partial<UsageRecord> = {}): UsageRecord => ({
  id,
  sessionId: 's1',
  model: 'anthropic/claude-sonnet-4-6',
  timestamp: new Date(2026, 9, 3, 12).getTime(),
  kind: 'inference',
  input: 100,
  output: 20,
  cacheRead: 800,
  cacheWrite: 100,
  ...values,
});
const prices = { 'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
it('deduplicates repeated inspections, including compaction usage', () => {
  expect(
    mergeUsage([r('1')], [r('1'), r('2', { kind: 'compaction' }), r('bad', { input: -1 })]),
  ).toHaveLength(2);
});
it('uses total input inclusive of both caches and weighted cache hit rates', () => {
  const groups = groupUsage(
    [r('1'), r('2', { input: 1000, cacheRead: 0, cacheWrite: 0 })],
    prices,
    'model',
  );
  expect(groups[0]).toMatchObject({
    input: 1100,
    cacheRead: 800,
    cacheWrite: 100,
    totalInput: 2000,
    output: 40,
    cacheRate: 0.4,
    calls: 2,
    unpriced: 0,
    unreported: 2,
  });
  expect(groups[0].cost).toBeCloseTo((1100 * 3 + 800 * 0.3 + 100 * 3.75 + 40 * 15) / 1e6);
});
it('keeps missing prices and reported costs distinct from zero and supports provider overrides', () => {
  expect(priceFor('reseller/claude-sonnet-4-6', prices)).toBeUndefined();
  const override = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(priceFor(r('1').model, { ...prices, [r('1').model]: override })).toEqual(override);
  const group = groupUsage(
    [r('1', { reportedCost: 0 }), r('2', { model: 'unknown/model' })],
    prices,
    'session',
  )[0];
  expect(group).toMatchObject({ unpriced: 1, unreported: 1, reportedCost: 0 });
  expect(validPrice({ ...override, input: NaN })).toBe(false);
});
it('groups different models by local date and logical conversation', () => {
  const records = [
    r('a'),
    r('b', { sessionId: 'branch', timestamp: new Date(2026, 9, 2, 12).getTime(), model: 'other' }),
  ];
  expect(groupUsage(records, prices, 'day').map((g) => g.key)).toEqual([
    '2026-10-03',
    '2026-10-02',
  ]);
  expect(groupUsage(records, prices, 'session')).toHaveLength(2);
});
it('normalizes Pi native usage without using context-window occupancy', () => {
  expect(
    usageRecord(
      'e',
      's',
      {
        provider: 'p',
        model: 'm',
        usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.1 } },
      },
      'fallback',
      'compaction',
      '2026-10-03',
    ),
  ).toMatchObject({ model: 'p/m', input: 2, cacheRead: 4, reportedCost: 0.1, kind: 'compaction' });
  expect(
    usageRecord('e', 's', { contextUsage: { tokens: 500 } }, 'fallback', 'inference', Date.now()),
  ).toBeUndefined();
});
