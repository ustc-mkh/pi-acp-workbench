// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createSessionSelector, type SessionSelector } from '../webview/selectors';
import { contextUsage } from '../webview/usage';
it('shows short model names without altering full menu labels or submitted IDs', () => {
  const control: SessionSelector = {
    label: 'Model',
    kind: 'model',
    current: 'openai-codex/gpt6',
    options: [
      { id: 'openai-codex/gpt6', name: 'openai-codex/GPT-6 Astra' },
      { id: 'anthropic/claude', name: 'anthropic/Claude Example' },
    ],
    change: { type: 'config', id: 'model' },
  };
  let submitted = '';
  const node = createSessionSelector(control, false, (value) => {
    submitted = value;
  });
  const select = node.querySelector('select')!;
  expect(node.querySelector('.selector-label')?.textContent).toBe('GPT-6 Astra');
  expect([...select.options].map((o) => o.text)).toEqual([
    'openai-codex/GPT-6 Astra',
    'anthropic/Claude Example',
  ]);
  select.value = 'anthropic/claude';
  select.dispatchEvent(new Event('change'));
  expect(submitted).toBe('anthropic/claude');
  expect(node.querySelector('.selector-label')?.textContent).toBe('Claude Example');
  expect(node.dataset.tooltip).toBe('anthropic/Claude Example');
  expect(select.hasAttribute('title')).toBe(false);
});
it('clamps the usage ring while preserving actual token counts in its tooltip', () => {
  expect(contextUsage({ used: 32000, size: 128000 })).toEqual({
    known: true,
    percent: 25,
    label: '32k/128k',
  });
  expect(contextUsage({ used: 150000, size: 128000 })).toEqual({
    known: true,
    percent: 100,
    label: '150k/128k',
  });
  expect(contextUsage({ used: 0, size: 200000 })).toEqual({
    known: true,
    percent: 0,
    label: '0k/200k',
  });
});
it('does not claim zero usage when the agent has not reported a valid capacity', () => {
  for (const value of [undefined, { used: 10, size: 0 }, { used: NaN, size: 100 }])
    expect(contextUsage(value).known).toBe(false);
});
