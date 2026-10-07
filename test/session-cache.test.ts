import { it, expect, vi } from 'vitest';
import { SessionCache } from '../src/session-cache';
const value = () => ({ agent: { dispose: vi.fn(), isClosed: false } });
it('retains only bounded idle connections and disposes LRU, oversized and closed entries', () => {
  const cache = new SessionCache<ReturnType<typeof value>>(2, 100),
    a = value(),
    b = value(),
    c = value();
  cache.put('a', a, 40);
  cache.put('b', b, 40);
  expect(cache.take('a')).toBe(a);
  cache.put('a', a, 40);
  cache.put('c', c, 40);
  expect(b.agent.dispose).toHaveBeenCalledOnce();
  expect(cache.get('a')).toBe(a);
  const large = value();
  cache.put('large', large, 101);
  expect(large.agent.dispose).toHaveBeenCalledOnce();
  a.agent.isClosed = true;
  expect(cache.take('a')).toBeUndefined();
  cache.clear();
  expect(c.agent.dispose).toHaveBeenCalledOnce();
  expect(cache.size).toBe(0);
});
