// Independent tasks only: ordered results, bounded workers, no fail-fast hiding failures.
export async function testPool(tasks, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('TEST_JOBS must be an integer from 1 to 8');
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        const started = performance.now();
        try {
          await tasks[index].run();
          results[index] = { name: tasks[index].name, ok: true, ms: performance.now() - started };
        } catch (error) {
          results[index] = {
            name: tasks[index].name,
            ok: false,
            error,
            ms: performance.now() - started,
          };
        }
      }
    }),
  );
  return results;
}
