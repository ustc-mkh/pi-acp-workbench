// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ModelsPage, visibleModelSelector } from '../webview/models';
import { initialState } from '../src/state';
it('filters model choices while preserving the current model', () => {
  const control = {
    kind: 'model',
    current: 'b',
    options: ['a', 'b', 'c'].map((id) => ({ id, name: id })),
  };
  expect(visibleModelSelector(control, ['a']).options.map((o) => o.id)).toEqual(['a', 'b']);
  expect(visibleModelSelector(control, []).options.map((o) => o.id)).toEqual(['b']);
  expect(visibleModelSelector(control).options).toEqual(control.options);
});
it('searches the complete catalogue and sends harness-scoped selections', () => {
  const root = document.createElement('section'),
    messages: unknown[] = [];
  document.body.append(root);
  const page = new ModelsPage(
    root,
    (message) => messages.push(message),
    () => {},
  );
  const state = initialState();
  state.harness = 'codex';
  state.visibleModels = ['a'];
  state.configs = [
    {
      id: 'model',
      type: 'select',
      category: 'model',
      name: 'Model',
      currentValue: 'b',
      options: ['a', 'b', 'c'].map((value) => ({ value, name: `Model ${value}` })),
    },
  ];
  page.update(state);
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
  boxes[2].click();
  expect(messages.at(-1)).toEqual({
    type: 'setVisibleModels',
    harness: 'codex',
    models: ['a', 'c'],
  });
  const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
  search.value = 'Model c';
  search.dispatchEvent(new Event('input'));
  expect(
    [...root.querySelectorAll<HTMLElement>('.model-row')].filter((row) => !row.hidden),
  ).toHaveLength(1);
  [...root.querySelectorAll('button')].find((b) => b.textContent === '显示全部')!.click();
  expect(messages.at(-1)).toEqual({ type: 'setVisibleModels', harness: 'codex', models: null });
});
