import { expect, it } from 'vitest';
import { sessionSelectors } from '../webview/selectors';
import type { ChatState } from '../src/shared';
const modes = { currentModeId: 'low', availableModes: ['low', 'medium', 'high'].map(id => ({ id, name: `Thinking: ${id}` })) };
const thinking = { type: 'select' as const, id: 'thinking', category: 'thought_level', name: 'Thinking', currentValue: 'low', options: modes.availableModes.map(m => ({ value: m.id, name: m.name })) };
it('uses one config selector for Pi modes and thought_level without changing protocol values', () => {
  const controls = sessionSelectors({ modes, configs: [thinking] });
  expect(controls).toHaveLength(1);
  expect(controls[0]).toMatchObject({ current: 'low', change: { type: 'config', id: 'thinking' }, options: [{ id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' }] });
});
it('hides only Codex fast mode and collaboration mode, retaining reasoning and permissions',()=>{
  const configs=[thinking,{...thinking,id:'fast-mode',name:'Fast mode',category:'model_config'},
    {...thinking,id:'collaboration_mode',name:'Collaboration mode',category:'collaboration_mode'},
    {...thinking,id:'mode',name:'Permissions',category:'mode'}];
  expect(sessionSelectors({harness:'codex',configs}).map(c=>c.change)).toEqual([{type:'config',id:'thinking'},{type:'config',id:'mode'}]);
  expect(sessionSelectors({harness:'pi',configs})).toHaveLength(4);
});
it('retains the legacy mode API when config options are absent', () => {
  expect(sessionSelectors({ modes })[0]).toMatchObject({ change: { type: 'mode' }, options: [{ id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' }] });
});
it('keeps unrelated session modes and model selectors', () => {
  const independentModes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'edit', name: 'Edit' }] };
  const model = { ...thinking, id: 'model', category: 'model', name: 'Model', currentValue: 'model-1', options: [{ value: 'model-1', name: 'Thinking: Model' }] };
  const controls = sessionSelectors({ modes: independentModes, configs: [model, thinking] });
  expect(controls).toHaveLength(3); expect(controls[0].options[0].name).toBe('Ask'); expect(controls[1].options[0].name).toBe('Thinking: Model');
});
it('recognizes grouped thought-level options and reordered levels', () => {
  const grouped: ChatState['configs'] = [{ ...thinking, options: [{ group: 'effort', name: 'Effort', options: [...thinking.options].reverse() }] }];
  expect(sessionSelectors({ modes, configs: grouped })).toHaveLength(1);
});
it('prefers the standard mode config when it replaces legacy modes', () => {
  expect(sessionSelectors({ modes, configs: [{ ...thinking, category: 'mode' }] })).toHaveLength(1);
});
it('hides stale legacy thinking modes when another provider supports fewer levels', () => {
  const controls = sessionSelectors({ modes, configs: [{ ...thinking, options: thinking.options.slice(0, 2) }] });
  expect(controls).toHaveLength(1); expect(controls[0].options).toHaveLength(2);
});
it('recognizes provider thinking labels even when its mode IDs differ', () => {
  const providerModes = { currentModeId: 'adaptive', availableModes: [{ id: 'adaptive', name: 'Thinking: adaptive' }, { id: 'budget', name: 'Thinking: budget' }] };
  expect(sessionSelectors({ modes: providerModes, configs: [thinking] })).toHaveLength(1);
});
it('keeps only the canonical thought_level config when another alias is also present', () => {
  const alias = { ...thinking, id: 'reasoning_effort', category: 'model_config', name: 'Reasoning effort' };
  const controls = sessionSelectors({ modes, configs: [alias, thinking] });
  expect(controls).toHaveLength(1); expect(controls[0].change).toEqual({ type: 'config', id: 'thinking' });
});
