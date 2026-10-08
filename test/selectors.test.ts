import { expect, it } from 'vitest';
import { sessionSelectors } from '../webview/selectors';
import type { ChatState } from '../src/shared';
const modes = {
  currentModeId: 'low',
  availableModes: ['low', 'medium', 'high'].map((id) => ({ id, name: `Thinking: ${id}` })),
};
const thinking = {
  type: 'select' as const,
  id: 'thinking',
  category: 'thought_level',
  name: 'Thinking',
  currentValue: 'low',
  options: modes.availableModes.map((m) => ({ value: m.id, name: m.name })),
};
it('uses one config selector for Pi modes and thought_level without changing protocol values', () => {
  const controls = sessionSelectors({ harness: 'pi', modes, configs: [thinking] });
  expect(controls).toHaveLength(1);
  expect(controls[0]).toMatchObject({
    current: 'low',
    change: { type: 'config', id: 'thinking' },
    options: [
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
    ],
  });
});
it('exposes Codex fast mode while retaining the default collaboration mode', () => {
  const configs = [
    thinking,
    { ...thinking, id: 'fast-mode', name: 'Fast mode', category: 'model_config' },
    {
      ...thinking,
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      category: 'collaboration_mode',
    },
    { ...thinking, id: 'mode', name: 'Permissions', category: 'mode' },
  ];
  expect(sessionSelectors({ harness: 'codex', configs }).map((c) => c.change)).toEqual([
    { type: 'config', id: 'thinking' },
    { type: 'config', id: 'fast-mode' },
    { type: 'config', id: 'mode' },
  ]);
  expect(sessionSelectors({ harness: 'pi', configs })).toHaveLength(4);
});
it('does not infer Pi thinking controls from the old modes API', () => {
  expect(sessionSelectors({ harness: 'pi', modes })).toEqual([]);
});
it('keeps unrelated session modes and model selectors', () => {
  const independentModes = {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'edit', name: 'Edit' },
    ],
  };
  const model = {
    ...thinking,
    id: 'model',
    category: 'model',
    name: 'Model',
    currentValue: 'model-1',
    options: [{ value: 'model-1', name: 'Thinking: Model' }],
  };
  const controls = sessionSelectors({
    harness: 'claude',
    modes: independentModes,
    configs: [model, thinking],
  });
  expect(controls).toHaveLength(3);
  expect(controls[0].options[0].name).toBe('Ask');
  expect(controls[1].options[0].name).toBe('Thinking: Model');
});
it('recognizes grouped thought-level options and reordered levels', () => {
  const grouped: ChatState['configs'] = [
    {
      ...thinking,
      options: [{ group: 'effort', name: 'Effort', options: [...thinking.options].reverse() }],
    },
  ];
  expect(sessionSelectors({ harness: 'pi', modes, configs: grouped })).toHaveLength(1);
});
it('uses the current config control without duplicate Pi modes', () => {
  expect(
    sessionSelectors({ harness: 'pi', modes, configs: [{ ...thinking, category: 'mode' }] }),
  ).toHaveLength(1);
});
it('uses the current thinking catalogue after a model change', () => {
  const controls = sessionSelectors({
    harness: 'pi',
    modes,
    configs: [{ ...thinking, options: thinking.options.slice(0, 2) }],
  });
  expect(controls).toHaveLength(1);
  expect(controls[0].options).toHaveLength(2);
});
it('keeps only the canonical thought_level config when another alias is also present', () => {
  const alias = {
    ...thinking,
    id: 'reasoning_effort',
    category: 'model_config',
    name: 'Reasoning effort',
  };
  const controls = sessionSelectors({ harness: 'pi', modes, configs: [alias, thinking] });
  expect(controls).toHaveLength(1);
  expect(controls[0].change).toEqual({ type: 'config', id: 'thinking' });
});
