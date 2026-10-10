// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { PricesPage } from '../webview/prices';
import type { Statistics } from '../src/telemetry';
it('refreshes missing defaults and fills fields after restoring defaults, including zero prices', () => {
  const root = document.createElement('main'),
    send = vi.fn();
  const page = new PricesPage(root, send, () => {});
  const data: Statistics = {
    models: [{ id: 'openai/m', name: 'Model M' }],
    prices: {},
    records: [],
    available: true,
    titles: {},
  };
  page.update(data);
  const card = root.querySelector('.model-price-card')!;
  expect([...card.querySelectorAll('input')].every((i) => i.value === '')).toBe(true);
  [...root.querySelectorAll('button')].find((b) => b.textContent === '刷新默认价格')!.click();
  expect(send).toHaveBeenLastCalledWith({ type: 'refreshStatistics' });
  card.querySelectorAll('button')[1].click();
  expect(card.textContent).toContain('正在读取 Pi 默认单价');
  page.update({
    ...data,
    prices: {
      'openai/m': { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, source: 'Pi 模型配置' },
    },
  });
  expect([...card.querySelectorAll('input')].map((i) => i.value)).toEqual(['2', '0', '0', '8']);
  expect(card.textContent).toContain('Pi 默认单价');
  page.update({ ...data, note: '用量读取未完成：连接失败' });
  expect(root.querySelector('[role=status]')!.textContent).toContain('连接失败');
});
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
