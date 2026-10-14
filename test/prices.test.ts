// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { ModelSettingsPage } from '../webview/prices';
import { initialState } from '../src/state';
import type { ChatState } from '../src/shared';
const price = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 };
function fixture() {
  const root = document.createElement('main'),
    send = vi.fn();
  const page = new ModelSettingsPage(root, send, () => {});
  const state: ChatState = {
    ...initialState(),
    harness: 'pi',
    status: 'ready',
    sessionId: 's',
    modelContexts: { 'p/m': 1000 },
    configs: [
      {
        id: 'model',
        type: 'select',
        category: 'model',
        name: 'Model',
        currentValue: 'p/m',
        options: [{ value: 'p/m', name: 'Model M' }],
      },
    ],
    statistics: {
      models: [{ id: 'p/m', name: 'Model M' }],
      prices: { 'p/m': price },
      records: [],
      available: true,
      titles: {},
    },
  };
  page.update(state);
  const card = root.querySelector<HTMLElement>('.model-price-card')!;
  const click = (name: string) =>
    [...card.querySelectorAll('button')].find((b) => b.textContent === name)!.click();
  return { root, send, page, state, card, click };
}
it('keeps the displayed price baseline while editing or saving a stale draft', () => {
  const { root, page, state, card, click, send } = fixture();
  page.update({
    ...state,
    statistics: { ...state.statistics!, priceVersions: { 'p/m': 'original' } },
  });
  const field = card.querySelector<HTMLInputElement>('input[type=number]')!;
  field.value = '0';
  field.dispatchEvent(new Event('input'));
  page.update({
    ...state,
    statistics: {
      ...state.statistics!,
      prices: { 'p/m': { ...price, input: 9 } },
      priceVersions: { 'p/m': 'other-window' },
    },
  });
  click('保存');
  const request = send.mock.calls.at(-1)![0];
  expect(request.priceVersion).toBe('original');
  page.update({
    ...state,
    modelSettingsResult: { id: request.id, model: 'p/m', error: '价格已更新' },
  });
  expect(field.value).toBe('0');
  expect(card.textContent).toContain('价格已更新');
  // Re-opening the settings in a different session reloads a confirmed baseline.
  page.update({
    ...state,
    sessionId: 'other',
    statistics: {
      ...state.statistics!,
      prices: { 'p/m': { ...price, input: 9 } },
      priceVersions: { 'p/m': 'other-window' },
    },
  });
  expect(root.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('9');
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === '保存')!
    .click();
  expect(send.mock.calls.at(-1)![0].priceVersion).toBe('other-window');
});
it('has one compact heading, five fields, a visibility toggle and one save/reset pair', () => {
  const { root, card } = fixture();
  expect(root.querySelector('h2')?.textContent).toBe('模型设置');
  expect(card.querySelectorAll('h3')).toHaveLength(1);
  expect(card.querySelectorAll('input[type=number]')).toHaveLength(5);
  expect(card.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
  expect(card.querySelectorAll('button')).toHaveLength(2);
  expect(card.textContent).not.toContain('p/m');
  expect(card.textContent).not.toContain('默认单价');
  expect(
    [...card.querySelectorAll<HTMLInputElement>('input[type=number]')].map((i) => i.value),
  ).toEqual(['2', '0', '0', '8', '1']);
  expect([...root.querySelectorAll('button')].some((b) => b.textContent === '显示全部')).toBe(
    false,
  );
  expect(root.textContent).not.toContain('仅保留当前模型');
  expect(root.querySelector('.stats-heading .page-back')?.textContent).toBe('返回对话');
});
it('saves all five values in one message and preserves drafts until the matching acknowledgement', () => {
  const { card, click, send, page, state } = fixture();
  const input = card.querySelector<HTMLInputElement>('input[type=number]')!;
  input.value = '4';
  input.dispatchEvent(new Event('input'));
  const context = card.querySelector<HTMLInputElement>('.model-context-field input')!;
  context.value = '2';
  context.dispatchEvent(new Event('input'));
  page.update({
    ...state,
    statistics: { ...state.statistics!, prices: { 'p/m': { ...price, input: 9 } } },
  });
  expect(input.value).toBe('4');
  click('保存');
  const request = send.mock.calls.at(-1)![0];
  expect(request).toMatchObject({
    type: 'setModelSettings',
    harness: 'pi',
    sessionId: 's',
    model: 'p/m',
    values: { price: { ...price, input: 4 }, contextWindow: 2000 },
  });
  page.update({ ...state, status: 'connecting' });
  expect(input.value).toBe('4');
  expect(context.value).toBe('2');
  expect(card.textContent).toContain('正在保存');
  page.update({
    ...state,
    modelSettingsResult: { id: request.id, model: 'p/m', error: '写入失败' },
  });
  expect(input.value).toBe('4');
  expect(card.textContent).toContain('写入失败');
  click('恢复默认');
  const reset = send.mock.calls.at(-1)![0];
  expect(reset).toMatchObject({ type: 'setModelSettings', values: null });
  page.update({ ...state, modelSettingsResult: { id: reset.id, model: 'p/m' } });
  expect(input.value).toBe('2');
  expect(context.value).toBe('1');
});
it.each([
  [256, 256000],
  [0.001, 1],
  [1.001, 1001],
  [100000, 100000000],
])('converts %s k tokens to %s tokens without changing prices', (k, tokens) => {
  const { card, click, send, page, state } = fixture();
  page.update({ ...state, modelContexts: { 'p/m': tokens } });
  const context = card.querySelector<HTMLInputElement>('.model-context-field input')!;
  expect(context.value).toBe(String(k));
  click('保存');
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ values: { price, contextWindow: tokens } }),
  );
});
it('rejects invalid context/price fields and disables changes while busy', () => {
  const { card, click, send, page, state } = fixture();
  const context = card.querySelector<HTMLInputElement>('.model-context-field input')!;
  context.value = '0.0001';
  click('保存');
  expect(send).not.toHaveBeenCalled();
  context.value = '1';
  card.querySelector<HTMLInputElement>('input[type=number]')!.value = '-1';
  click('保存');
  expect(send).not.toHaveBeenCalled();
  page.update({ ...state, status: 'busy' });
  expect(context.disabled).toBe(true);
  expect([...card.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
});
it('refreshes the catalogue without replacing dirty fields and resets drafts on session switches', () => {
  const { root, card, page, state, send } = fixture();
  const field = card.querySelector<HTMLInputElement>('input[type=number]')!;
  field.value = '5';
  field.dispatchEvent(new Event('input'));
  [...root.querySelectorAll('button')].find((b) => b.textContent === '刷新模型配置')!.click();
  expect(send).toHaveBeenLastCalledWith({ type: 'refreshStatistics' });
  page.update(state);
  expect(field.value).toBe('5');
  page.update({ ...state, sessionId: 'other' });
  expect(root.querySelector<HTMLInputElement>('input[type=number]')!.value).toBe('2');
});
it('groups by provider collapsed by default and expands only for search or a model link', () => {
  const { root, page, state } = fixture();
  const group = root.querySelector<HTMLDetailsElement>('.provider-group')!;
  expect(group.open).toBe(false);
  expect(group.querySelector('summary')?.textContent).toBe('p（1 个模型）');
  page.update(state);
  expect(group.open).toBe(false);
  const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
  search.value = 'Model M';
  search.dispatchEvent(new Event('input'));
  expect(group.open).toBe(true);
  search.value = '';
  search.dispatchEvent(new Event('input'));
  expect(group.open).toBe(false);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  page.focus('p/m');
  expect(group.open).toBe(true);
});
it('sends provider visibility and reset operations, acknowledges reset without losing failed drafts', () => {
  const { root, page, state, send, card } = fixture();
  const button = (label: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.provider-actions button')].find(
      (b) => b.textContent === label,
    )!;
  button('全部不显示').click();
  expect(send).toHaveBeenLastCalledWith({
    type: 'setVisibleModels',
    harness: 'pi',
    sessionId: 's',
    affected: ['p/m'],
    models: [],
  });
  button('全部显示').click();
  expect(send).toHaveBeenLastCalledWith({
    type: 'setVisibleModels',
    harness: 'pi',
    sessionId: 's',
    affected: ['p/m'],
    models: ['p/m'],
  });
  const field = card.querySelector<HTMLInputElement>('input[type=number]')!;
  field.value = '5';
  field.dispatchEvent(new Event('input'));
  button('全部恢复默认').click();
  const request = send.mock.calls.at(-1)![0];
  expect(request).toMatchObject({
    type: 'resetProviderModels',
    provider: 'p',
    harness: 'pi',
    sessionId: 's',
  });
  expect(button('全部恢复默认').disabled).toBe(true);
  page.update({
    ...state,
    providerSettingsResult: { id: request.id, provider: 'p', models: [], error: '失败' },
  });
  expect(field.value).toBe('5');
  button('全部恢复默认').click();
  page.update({
    ...state,
    providerSettingsResult: { id: send.mock.calls.at(-1)![0].id, provider: 'p', models: ['p/m'] },
  });
  expect(field.value).toBe('2');
});
it('keeps other providers unchanged during bulk visibility changes', () => {
  const { root, page, state, send } = fixture();
  state.configs = [
    {
      id: 'model',
      type: 'select',
      name: 'Model',
      category: 'model',
      currentValue: 'p/m',
      options: ['p/m', 'p/n', 'q/m', 'q/n'].map((value) => ({ value, name: value })),
    },
  ];
  state.visibleModels = ['p/m', 'q/n'];
  page.update(state);
  const group = root.querySelector('[data-provider="p"]')!;
  [...group.querySelectorAll('button')].find((b) => b.textContent === '全部显示')!.click();
  expect(send).toHaveBeenLastCalledWith({
    type: 'setVisibleModels',
    harness: 'pi',
    sessionId: 's',
    affected: ['p/m', 'p/n'],
    models: ['p/m', 'p/n'],
  });
  [...group.querySelectorAll('button')].find((b) => b.textContent === '全部不显示')!.click();
  expect(send).toHaveBeenLastCalledWith({
    type: 'setVisibleModels',
    harness: 'pi',
    sessionId: 's',
    affected: ['p/m', 'p/n'],
    models: [],
  });
});
it('selects the title model independently from the conversation model', () => {
  const { root, send, page, state } = fixture();
  const select = root.querySelector<HTMLSelectElement>('[aria-label="会话名压缩模型"]')!;
  select.value = 'p/m';
  select.dispatchEvent(new Event('change'));
  expect(send).toHaveBeenLastCalledWith({ type: 'setTitleModel', model: 'p/m' });
  page.update({ ...state, titleModel: 'p/m' });
  expect(select.value).toBe('p/m');
  expect(root.querySelector('.page-back')?.textContent).toContain('返回');
});
