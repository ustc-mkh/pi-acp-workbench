import { expect, it } from 'vitest';
import { PiEventBacklog } from '../src/pi-event-backlog';
it('replays early lifecycle and messages in order exactly once', () => {
  const backlog = new PiEventBacklog();
  backlog.push({ type: 'agent_start' });
  backlog.push({ type: 'message_end', text: '后台任务完成' });
  const events: unknown[] = [];
  backlog.drain((event) => events.push(event));
  backlog.drain((event) => events.push(event));
  expect(events).toEqual([{ type: 'agent_start' }, { type: 'message_end', text: '后台任务完成' }]);
});
it('rejects over-budget startup events instead of silently dropping a run', () => {
  const bytes = new PiEventBacklog();
  expect(() => bytes.push({ text: 'x'.repeat(4 * 1024 * 1024) })).toThrow('limit');
  const count = new PiEventBacklog();
  for (let i = 0; i < 10000; i++) count.push({ type: 'agent_start' });
  expect(() => count.push({ type: 'agent_settled' })).toThrow('limit');
});
