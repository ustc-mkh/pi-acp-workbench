import { afterEach, expect, it, vi } from 'vitest';
import { PaintScheduler } from '../webview/paint-scheduler';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 1));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const paint = vi.fn();
  return { paint, scheduler: new PaintScheduler(paint, 80) };
};

it('coalesces streaming chunks and paints the latest state on a bounded interval', () => {
  const { scheduler, paint } = setup();
  scheduler.request(true, 'one');
  vi.advanceTimersByTime(1);
  expect(paint).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) {
    scheduler.request(true, 'one');
    vi.advanceTimersByTime(2);
  }
  expect(paint).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(41);
  expect(paint).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  'flushes pending paints on completion or session switch (%s)',
  (switching) => {
    const { scheduler, paint } = setup();
    scheduler.request(true, 'one');
    vi.advanceTimersByTime(1);
    scheduler.request(true, 'one');
    scheduler.request(switching, switching ? 'two' : 'one');
    vi.advanceTimersByTime(1);
    expect(paint).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(paint).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);
