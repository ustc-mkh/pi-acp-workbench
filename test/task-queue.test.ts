import { expect, it, vi } from 'vitest';
import { TaskQueue } from '../src/task-queue';
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
it('cancels queued generations but lets later work proceed in session order', async () => {
  const queue = new TaskQueue(1),
    hold = gate(),
    ran: string[] = [];
  const first = queue.run('one', async () => {
    ran.push('first');
    await hold.promise;
  });
  await vi.waitFor(() => expect(ran).toEqual(['first']));
  const second = queue
    .run('one', async () => {
      ran.push('second');
    })
    .catch((error) => error.message);
  queue.cancel('one');
  const third = queue.run('one', async () => {
    ran.push('third');
  });
  hold.resolve();
  await first;
  expect(await second).toContain('取消');
  await third;
  expect(ran).toEqual(['first', 'third']);
  expect(queue.pendingCount).toBe(0);
  await queue.close();
});
it('caps global execution and rejects new work while draining', async () => {
  const queue = new TaskQueue(2),
    hold = gate(),
    ran: string[] = [];
  const work = (id: string) =>
    queue.run(id, async () => {
      ran.push(id);
      await hold.promise;
    });
  const a = work('a'),
    b = work('b'),
    c = work('c').catch((error) => error.message);
  await vi.waitFor(() => expect(ran).toEqual(['a', 'b']));
  const draining = queue.close();
  await expect(work('d')).rejects.toThrow('停止');
  hold.resolve();
  await Promise.all([a, b, draining]);
  expect(await c).toContain('取消');
  expect(queue.pendingCount).toBe(0);
});
