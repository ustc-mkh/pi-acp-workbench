import { it, expect } from 'vitest';
import { validPrice, validRecord, type UsageRecord } from '../src/telemetry';
import { usageRecord } from '../src/pi-enhancements';

const record: UsageRecord = {
  id: 'native-entry',
  sessionId: 'native-session',
  model: 'anthropic/claude-sonnet-4-6',
  timestamp: 1000,
  kind: 'inference',
  input: 100,
  output: 20,
  cacheRead: 800,
  cacheWrite: 100,
};
it('validates provider usage records without a UI aggregation/cache projection', () => {
  expect(validRecord(record)).toBe(true);
  expect(validRecord({ ...record, reportedCost: 0 })).toBe(true);
  for (const invalid of [
    null,
    {},
    { ...record, id: 'x'.repeat(500) },
    { ...record, model: 'x'.repeat(300) },
    { ...record, timestamp: 0 },
    { ...record, timestamp: Infinity },
    { ...record, input: -1 },
    { ...record, output: 0.5 },
    { ...record, cacheRead: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, cacheWrite: NaN },
    { ...record, reportedCost: -1 },
    { ...record, reportedCost: NaN },
  ])
    expect(validRecord(invalid)).toBe(false);
});
it('keeps zero reported provider prices distinct from absent or invalid prices', () => {
  const price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(validPrice(price)).toBe(true);
  for (const invalid of [
    undefined,
    {},
    { ...price, input: NaN },
    { ...price, output: -1 },
    { ...price, cacheWrite: 1000001 },
  ])
    expect(validPrice(invalid)).toBe(false);
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
