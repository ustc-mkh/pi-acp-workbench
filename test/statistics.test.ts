// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { StatisticsPage } from '../webview/statistics';
import type { Statistics } from '../src/telemetry';
it('sorts models by estimated cost and sessions by numeric session number descending', () => {
  const root = document.createElement('main');
  const page = new StatisticsPage(root, vi.fn(), () => {}, vi.fn());
  const data: Statistics = {
    available: true,
    titles: {},
    sessionNumbers: { old: 9, recent: 100, middle: 20 },
    prices: {
      cheap: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      expensive: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    records: [
      ['old', 'cheap', 10000],
      ['recent', 'expensive', 1000],
      ['middle', 'cheap', 100],
      ['unknown', 'unpriced', 100000],
    ].map(([sessionId, model, input], index) => ({
      id: String(index),
      sessionId: String(sessionId),
      model: String(model),
      input: Number(input),
      timestamp: new Date(2026, 9, 3, 12).getTime(),
      kind: 'inference' as const,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
  };
  const names = () =>
    [...root.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);
  page.update(data);
  expect(names()).toEqual(['expensive', 'cheap', 'unpriced']);
  const click = (label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === label)!.click();
  click('按会话');
  expect(names()).toEqual(['#100 recent', '#20 middle', '#9 old', 'unknown']);
  page.update({ ...data, sessionNumbers: { ...data.sessionNumbers, old: 101 } });
  expect(names()).toEqual(['#101 old', '#100 recent', '#20 middle', 'unknown']);
  click('按模型');
  page.update({
    ...data,
    prices: { ...data.prices, cheap: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
  });
  expect(names()).toEqual(['cheap', 'expensive', 'unpriced']);
  const from = root.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!;
  from.value = '2026-10-04';
  from.dispatchEvent(new Event('change'));
  expect(names()).toEqual([]);
});
it('switches model/time/session views, filters dates, and links models without hover popups', () => {
  document.body.innerHTML = '<main></main>';
  HTMLElement.prototype.scrollIntoView = () => {};
  const root = document.querySelector('main')!,
    send = vi.fn(),
    open = vi.fn(),
    page = new StatisticsPage(root, send, () => {}, open);
  const data: Statistics = {
    available: true,
    titles: { s: '数学任务' },
    sessionNumbers: { s: 14 },
    prices: { 'p/m': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
    records: [
      {
        id: '1',
        sessionId: 's',
        model: 'p/m',
        timestamp: new Date(2026, 9, 3, 12).getTime(),
        kind: 'inference',
        input: 1000,
        cacheRead: 1000,
        cacheWrite: 0,
        output: 200,
      },
    ],
  };
  page.update(data);
  expect(root.textContent).toContain('50.0%');
  expect(root.querySelector('tbody')?.textContent).toContain('p/m');
  const click = (label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === label)!.click();
  click('按时间');
  expect(root.querySelector('.usage-chart')?.textContent).toContain('2026-10-03');
  expect(root.querySelector('.usage-chart')?.textContent).toContain('$0.0042');
  click('按周');
  expect(root.querySelector('.usage-chart')?.textContent).toContain('2026-09-28');
  click('按月');
  expect(root.querySelector('.usage-chart')?.textContent).toContain('2026-10');
  click('按会话');
  expect(root.querySelector('tbody')?.textContent).toContain('#14 数学任务');
  expect(root.querySelector('tbody [data-tooltip], tbody [title]')).toBeNull();
  const from = root.querySelector<HTMLInputElement>('[aria-label="开始日期"]')!;
  from.value = '2026-10-04';
  from.dispatchEvent(new Event('change'));
  expect(root.textContent).toContain('暂无用量');
  click('全部日期');
  click('按模型');
  (root.querySelector('.stats-model-link') as HTMLElement).click();
  expect(open).toHaveBeenLastCalledWith('p/m');
  expect(root.textContent).not.toContain('Pi 报告费用');
  expect(root.querySelector('input[type=number]')).toBeNull();
  expect(root.textContent).not.toContain('模型设置 →');
  expect(root.querySelector('.page-back')?.textContent).toBe('返回对话');
  expect(root.querySelector('tbody [data-tooltip], tbody [title]')).toBeNull();
});
