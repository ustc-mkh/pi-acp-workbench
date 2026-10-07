// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { PricesPage } from '../webview/prices';
import type { Statistics } from '../src/telemetry';
it('lists only configured models with four editable prices each and retains unsaved edits across updates', () => {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!,
    send = vi.fn(),
    page = new PricesPage(root, send, () => {});
  const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
  const data: Statistics = {
    models: [
      { id: 'openai/m', name: 'Model M' },
      { id: 'other/n', name: 'Model N' },
    ],
    prices: { m: price, unused: price },
    records: [],
    available: true,
    titles: {},
  };
  page.update(data);
  expect(root.querySelectorAll('.model-price-card')).toHaveLength(2);
  expect(root.querySelectorAll('input')).toHaveLength(8);
  expect(root.textContent).not.toContain('unused');
  const card = root.querySelector('.model-price-card')!,
    field = card.querySelector('input')!;
  expect(field.value).toBe('2');
  field.value = '4';
  field.dispatchEvent(new Event('input'));
  page.update({ ...data, prices: { ...data.prices, m: { ...price, input: 7 } } });
  expect(field.value).toBe('4');
  card.querySelector('button')!.click();
  expect(send).toHaveBeenLastCalledWith({
    type: 'setPrice',
    model: 'openai/m',
    price: { ...price, input: 4 },
  });
  page.update({
    ...data,
    prices: { ...data.prices, 'openai/m': { ...price, input: 4, source: '用户设置' } },
  });
  expect(card.textContent).toContain('已保存');
  card.querySelectorAll('button')[1].click();
  expect(send).toHaveBeenLastCalledWith({ type: 'setPrice', model: 'openai/m' });
  page.update(data);
  expect(field.value).toBe('2');
});
