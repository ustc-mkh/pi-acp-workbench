// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {TranscriptView,transcriptBlocks} from '../webview/transcript';
import type {Entry} from '../src/shared';
const user:Entry = {id:'u',role:'user',text:'task'};
const thought:Entry = {id:'t',role:'thought',text:'thinking'};
const tool:Entry = {id:'tool',role:'tool',tool:{toolCallId:'call',title:'read',status:'completed'}};
const answer:Entry = {id:'a',role:'assistant',text:'answer'};
it('groups a whole execution trace, preserving the user request and final answer',()=>{
  const entries:Entry[] = [user,thought,{id:'n',role:'assistant',text:'next step'},tool,answer];
  const blocks = transcriptBlocks(entries);
  expect(blocks.map(b=>b.kind)).toEqual(['message','activity','message']);
  expect(blocks[1]).toMatchObject({entries:[thought,entries[2],tool]});
  expect(transcriptBlocks([...entries,{...user,id:'u2'}, {...tool,id:'tool2'}])).toHaveLength(5);
});
it('keeps groups folded by default, preserves toggles while streaming, and supports fold-all',()=>{
  const root = document.createElement('div');
  const view = new TranscriptView(root,entry=>{const node=document.createElement('article');node.textContent=entry.id;return node;});
  view.update([user,thought,tool,answer],false);
  const group = root.querySelector('details')!;
  expect(group.open).toBe(false); expect(group.querySelector('summary')!.textContent).toContain('1 次工具调用');
  group.open=true;
  view.update([user,{...thought,text:'more thinking'},tool,answer],true);
  expect(root.querySelector('details')).toBe(group); expect(group.open).toBe(true);
  expect(root.lastElementChild!.textContent).toBe('a');
  view.setExpanded(false);expect(group.open).toBe(false);
  view.setExpanded(true);expect(group.open).toBe(true);
  view.update([user,answer],false);expect(root.querySelector('details')).toBeNull();
});
it('moves interim assistant messages into the trace when a later tool arrives',()=>{
  const root = document.createElement('div');
  const view = new TranscriptView(root,entry=>{const node=document.createElement('article');node.dataset.id=entry.id;return node;});
  view.update([user,thought,answer],true);
  const existing = root.querySelector('[data-id=a]');
  view.update([user,thought,answer,tool],true);
  expect(root.querySelector('.activity-body [data-id=a]')).toBe(existing);
});
