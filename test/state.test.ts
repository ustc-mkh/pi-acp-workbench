import { it, expect } from 'vitest';
import { applyUpdate, initialState } from '../src/state';
it('merges streamed chunks but separates message IDs, roles and tool boundaries', () => {
  const s = initialState();
  const chunk = (text: string, messageId = 'a') => applyUpdate(s, { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
  chunk('hello'); chunk(' world'); chunk('new', 'b');
  expect(s.entries).toHaveLength(2); expect(s.entries[0]).toMatchObject({ text: 'hello world' });
  applyUpdate(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }); chunk('after', 'c'); expect(s.entries).toHaveLength(4);
});
it('retains tool title/input on partial status updates', () => {
  const s = initialState();
  applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'in_progress', rawInput: { path: 'x.ts' } });
  applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: null, content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
  expect(s.entries).toHaveLength(1); expect(s.entries[0]).toMatchObject({ tool: { title: 'Read file', status: 'completed', rawInput: { path: 'x.ts' } } });
});
it('suppresses user echoes live and accepts replayed user messages', () => {
  const s = initialState(); const u = { sessionUpdate: 'user_message_chunk' as const, content: { type: 'text' as const, text: 'hello' } };
  applyUpdate(s, u); expect(s.entries).toHaveLength(0); applyUpdate(s, u, true); expect(s.entries).toHaveLength(1);
});
it('supports tool updates arriving before the initial notification', () => {
  const s = initialState(); applyUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }); expect(s.entries[0]).toMatchObject({ tool: { title: '工具调用', status: 'completed' } });
});
it('uses distinct UI keys when a protocol message spans a tool boundary', () => {
  const s = initialState();
  const chunk = { sessionUpdate: 'agent_message_chunk' as const, messageId: 'm1', content: { type: 'text' as const, text: 'text' } };
  applyUpdate(s, chunk); applyUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read' }); applyUpdate(s, chunk);
  expect(new Set(s.entries.map(e => e.id)).size).toBe(3);
});
