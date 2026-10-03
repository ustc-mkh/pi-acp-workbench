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
