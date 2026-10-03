import { expect, it } from 'vitest';
import { initialState } from '../src/state';
import { StateEncoder, applyStatePatch } from '../src/state-channel';

it('sends only changed entries, retaining image and statistics identities', () => {
  const encoder = new StateEncoder();
  const source = initialState();
  source.sessionId = 'one';
  source.entries = [{id:'user',role:'user',text:'image',contextBlocks:[{type:'image',mimeType:'image/png',data:'A'.repeat(100000)}]}, {id:'answer',role:'assistant',text:'hello'}];
  source.statistics = {records:[],prices:{},titles:{},available:true};
  expect(encoder.encode(source).type).toBe('state');
  const receiver = structuredClone(source);
  if(source.entries[1].role !== 'tool') source.entries[1].text += ' world';
  source.error = 'example';
  const patch = encoder.encode(source);
  expect(patch.type).toBe('statePatch');
  if(patch.type !== 'statePatch') throw new Error('Expected patch');
  expect(JSON.stringify(patch).length).toBeLessThan(500);
  const next = applyStatePatch(receiver, structuredClone(patch));
  expect(next).toEqual(source);
  expect(next.entries[0]).toBe(receiver.entries[0]);
  expect(next.statistics).toBe(receiver.statistics);
  source.error = undefined;
  source.entries = [source.entries[1], {id:'new',role:'assistant',text:'another'}];
  const changed = encoder.encode(source);
  if(changed.type !== 'statePatch') throw new Error('Expected patch');
  // Match JSON transport, where undefined fields are omitted.
  expect(applyStatePatch(next, JSON.parse(JSON.stringify(changed)))).toEqual(source);
});
it('resets on session switches and webview reloads', () => {
  const encoder = new StateEncoder(), state = initialState();
  expect(encoder.encode(state)).toMatchObject({type:'state',revision:1});
  expect(encoder.encode(state)).toMatchObject({type:'statePatch',revision:2});
  state.sessionId = 'new';
  expect(encoder.encode(state)).toMatchObject({type:'state',revision:1});
  encoder.reset();
  expect(encoder.encode(state)).toMatchObject({type:'state',revision:1});
});
