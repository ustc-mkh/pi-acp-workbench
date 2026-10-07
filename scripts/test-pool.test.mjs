import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPool } from './lib/test-pool.mjs';
import { setTimeout as delay } from 'node:timers/promises';
test('bounds overlap, runs every task after failure and preserves report order', async () => {
  let active = 0,
    peak = 0,
    finished = 0;
  const tasks = Array.from({ length: 7 }, (_, i) => ({
    name: String(i),
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(5);
        if (i === 2) throw new Error('injected');
      } finally {
        active--;
        finished++;
      }
    },
  }));
  const results = await testPool(tasks, 2);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(finished, 7);
  assert.deepEqual(
    results.map((r) => r.name),
    tasks.map((t) => t.name),
  );
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.match(results[2].error.message, /injected/);
});
test('serial mode and invalid concurrency', async () => {
  const order = [];
  await testPool(
    [0, 1, 2].map((i) => ({ name: String(i), run: async () => order.push(i) })),
    1,
  );
  assert.deepEqual(order, [0, 1, 2]);
  for (const n of [0, -1, 1.5, 9, NaN]) await assert.rejects(testPool([], n), /TEST_JOBS/);
});
