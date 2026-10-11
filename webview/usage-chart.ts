import type { UsageGroup } from '../src/telemetry';
/** Dependency-free, accessible column chart; never turn an unknown price into zero. */
export function usageChart(rows: UsageGroup[], unit: 'day' | 'week' | 'month'): HTMLElement {
  const chart = document.createElement('div');
  chart.className = 'usage-chart';
  chart.setAttribute('role', 'list');
  chart.setAttribute(
    'aria-label',
    `按${{ day: '天', week: '周（周一开始）', month: '月' }[unit]}统计费用`,
  );
  const maximum = rows.reduce((max, row) => Math.max(max, row.cost), 0.0001);
  for (const row of [...rows].reverse()) {
    const column = document.createElement('div');
    column.className = 'usage-column';
    column.setAttribute('role', 'listitem');
    const amount = '$' + row.cost.toFixed(4) + (row.unpriced ? ' + 未定价' : '');
    column.setAttribute('aria-label', `${row.key} ${amount}`);
    const value = document.createElement('span');
    value.className = 'usage-bar-value';
    value.textContent = amount;
    const track = document.createElement('div');
    track.className = 'usage-bar-track';
    const bar = document.createElement('div');
    bar.className = 'usage-bar';
    bar.style.height = `${(row.cost / maximum) * 100}%`;
    track.append(bar);
    const label = document.createElement('span');
    label.className = 'usage-bar-label';
    label.textContent = row.key;
    column.append(value, track, label);
    chart.append(column);
  }
  return chart;
}
