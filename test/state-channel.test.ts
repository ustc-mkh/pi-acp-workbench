import { expect, it, vi } from 'vitest';
import { applyUpdate, initialState } from '../src/state';
import { StateEncoder, applyStatePatch } from '../src/state-channel';

it('sends only changed entries, retaining image and statistics identities', () => {
  const encoder = new StateEncoder();
  const source = initialState();
  source.sessionId = 'one';
  source.entries = [
    {
      id: 'user',
      role: 'user',
      text: 'image',
      contextBlocks: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(100000) }],
    },
    { id: 'answer', role: 'assistant', text: 'hello' },
  ];
  source.statistics = { records: [], prices: {}, titles: {}, available: true };
  expect(encoder.encode(source).type).toBe('state');
  const receiver = structuredClone(source);
  const originalAnswer = Object.freeze(source.entries[1]);
  const stringify = vi.spyOn(JSON, 'stringify');
  applyUpdate(source, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' world' },
  });
  source.error = 'example';
  const patch = encoder.encode(source);
  const serializedLargeFields = stringify.mock.calls.some(
    ([value]) => value === source.entries[0] || value === source.statistics,
  );
  stringify.mockRestore();
  expect(serializedLargeFields).toBe(false);
  expect(originalAnswer).toMatchObject({ text: 'hello' });
  expect(patch.type).toBe('statePatch');
  if (patch.type !== 'statePatch') throw new Error('Expected patch');
  expect(JSON.stringify(patch).length).toBeLessThan(500);
  const next = applyStatePatch(receiver, structuredClone(patch));
  expect(next).toEqual(source);
  expect(next.entries[0]).toBe(receiver.entries[0]);
  expect(next.statistics).toBe(receiver.statistics);
  source.error = undefined;
  source.entries = [source.entries[1], { id: 'new', role: 'assistant', text: 'another' }];
  const changed = encoder.encode(source);
  if (changed.type !== 'statePatch') throw new Error('Expected patch');
  // Match JSON transport, where undefined fields are omitted.
  expect(applyStatePatch(next, JSON.parse(JSON.stringify(changed)))).toEqual(source);
});
it('delivers replaced tool, attachment and statistics values without mutating earlier messages', () => {
  const source = initialState(),
    encoder = new StateEncoder();
  applyUpdate(source, {
    sessionUpdate: 'tool_call',
    toolCallId: 't',
    title: 'Read',
    status: 'in_progress',
  });
  const previous = source.entries[0];
  if (previous.role !== 'tool') throw new Error('Expected tool');
  Object.freeze(previous.tool);
  encoder.encode(source);
  const receiver = structuredClone(source);
  applyUpdate(source, { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
  source.attachments = [
    { id: 'image', kind: 'image', name: 'screenshot', mimeType: 'image/png', data: 'AAAA' },
  ];
  source.statistics = { available: true, records: [], prices: {}, titles: {} };
  const patch = encoder.encode(source);
  if (patch.type !== 'statePatch') throw new Error('Expected patch');
  expect(applyStatePatch(receiver, structuredClone(patch))).toEqual(source);
  expect(previous.tool.status).toBe('in_progress');
});
it('resets on session switches and webview reloads', () => {
  const encoder = new StateEncoder(),
    state = initialState();
  expect(encoder.encode(state)).toMatchObject({ type: 'state', revision: 1 });
  expect(encoder.encode(state)).toMatchObject({ type: 'statePatch', revision: 2 });
  state.sessionId = 'new';
  expect(encoder.encode(state)).toMatchObject({ type: 'state', revision: 1 });
  encoder.reset();
  expect(encoder.encode(state)).toMatchObject({ type: 'state', revision: 1 });
});
