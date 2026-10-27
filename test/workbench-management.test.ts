import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { telegramConfiguration } from '../src/workbench-setup';
import { emptyView } from './helpers/workbench-peer';
import { Preferences } from '../webview/workbench-preferences';
import { ManagementPanel } from '../webview/workbench-management';
import type { UiCommand } from '../src/workbench-ui';
import type { ManagementData } from '../src/workbench-protocol';
afterEach(() => vi.unstubAllGlobals());
it('generates only allowlisted Telegram config and never accepts a secret token or implicit first-sender pairing', () => {
  const input = {
    workspace: '/workspace',
    root: '/private/new-root',
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    user: '42',
    chat: '-1001234',
  };
  const result = telegramConfiguration(input);
  expect(result.telegram.allowed_user_ids).toEqual([42]);
  expect(result.telegram.allowed_chat_ids).toEqual([-1001234]);
  expect(JSON.stringify(result)).not.toContain('bot_token":');
  for (const change of [
    { tokenEnv: '1234:secret' },
    { user: '0' },
    { user: '-42' },
    { chat: '9007199254740992' },
    { workspace: 'relative' },
    { root: '/' },
  ])
    expect(() => telegramConfiguration({ ...input, ...change })).toThrow();
});
it('persists bounded rows/follow preferences without accepting malformed values', () => {
  const p = new Preferences({ preferences: { sessionRows: 16, autoScroll: false } });
  expect(p.sessionRows).toBe(16);
  expect(p.autoScroll).toBe(false);
  expect(new Preferences(p.snapshot()).sessionRows).toBe(16);
  expect(new Preferences({ preferences: { sessionRows: 10000 } }).sessionRows).toBe(4);
});
it('renders searchable grouped models, four prices, explicit context, titles and paged statistics as actual user actions', () => {
  const dom = new JSDOM('<main></main>');
  vi.stubGlobal('document', dom.window.document);
  const sent: UiCommand[] = [];
  const panel = new ManagementPanel(
    (m) => sent.push(m),
    () => {},
  );
  dom.window.document.body.append(panel.root);
  const view = emptyView();
  view.catalogue.models = [{ id: 'vendor/model' as never, name: 'Model <script>unsafe</script>' }];
  panel.setView(
    view,
    [
      {
        id: view.id,
        harness: view.harness,
        cwd: view.cwd,
        status: view.status,
        revision: view.revision,
        created_seq: 7,
        title: 'task',
      },
    ],
    [],
  );
  const request = sent.at(-1)!;
  expect(request.type).toBe('read_management');
  expect(sent.some((m) => m.type === 'execute')).toBe(false);
  const data: ManagementData = {
    naming_policy: 'follow',
    title_model: null,
    models: [
      {
        harness: 'Pi',
        model: 'vendor/model',
        hidden: false,
        price: null,
        default_price: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
        context_window: 256000,
      },
    ],
    groups: [],
    totals: null,
    next_cursor: null,
  };
  panel.receive({
    type: 'management',
    request_id: 'request_id' in request ? request.request_id : 0,
    data,
  });
  panel.openModels();
  const again = sent.at(-1)!;
  panel.receive({
    type: 'management',
    request_id: 'request_id' in again ? again.request_id : 0,
    data,
  });
  expect(dom.window.document.querySelector('script')).toBeNull();
  const click = (name: string) =>
    [...dom.window.document.querySelectorAll('button')]
      .find((n) => (n.getAttribute('aria-label') || n.textContent) === name)!
      .click();
  expect(dom.window.document.querySelector('.additional-settings')).toBeNull();
  expect(dom.window.document.body.textContent).not.toContain('会话命名与其他设置');
  expect(dom.window.document.querySelector('[aria-label="Session name"]')).toBeNull();
  expect(dom.window.document.querySelector('[aria-label="Automatic title policy"]')).toBeNull();
  const titleChoice =
    dom.window.document.querySelector<HTMLSelectElement>('[aria-label="会话名压缩模型"]')!;
  titleChoice.value = 'vendor/model';
  titleChoice.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(sent.at(-1)).toMatchObject({
    command: { action: { action: 'naming', policy: 'model', model: 'vendor/model' } },
  });
  click('刷新模型配置');
  expect(sent.at(-1)).toMatchObject({ command: { action: { action: 'refresh_models' } } });
  expect(
    [...dom.window.document.querySelectorAll('button')].some(
      (n) => (n.getAttribute('aria-label') || n.textContent) === '应用上下文设置',
    ),
  ).toBe(false);
  const context = dom.window.document.querySelector<HTMLInputElement>(
    '[aria-label="vendor/model context k tokens"]',
  )!;
  const multiplier = dom.window.document.querySelector<HTMLInputElement>(
    '[aria-label="vendor/model price multiplier"]',
  )!;
  expect(context.value).toBe('256');
  expect(multiplier.value).toBe('1');
  context.value = '512';
  multiplier.value = '0.5';
  click('保存模型设置');
  expect(sent.at(-1)).toMatchObject({
    type: 'execute',
    command: {
      method: 'manage',
      action: {
        action: 'model_config',
        price: null,
        multiplier: 0.5,
        context_window: 512000,
        apply_context: true,
      },
    },
  });
  click('隐藏全部模型');
  expect(sent.at(-1)).toMatchObject({
    command: { action: { action: 'visibility', models: ['vendor/model'], hidden: true } },
  });
  const input = dom.window.document.querySelector<HTMLInputElement>(
    '[aria-label="vendor/model input price"]',
  )!;
  input.value = '12.5';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const beforeRefresh = sent.filter((m) => m.type === 'execute').length;
  panel.openModels();
  const refreshed = sent.at(-1)!;
  panel.receive({
    type: 'management',
    request_id: 'request_id' in refreshed ? refreshed.request_id : 0,
    data,
  });
  expect(
    dom.window.document.querySelector<HTMLInputElement>('[aria-label="vendor/model input price"]')!
      .value,
  ).toBe('12.5');
  expect(sent.filter((m) => m.type === 'execute')).toHaveLength(beforeRefresh);
  panel.openStatistics();
  const stats = sent.at(-1)!;
  const row = {
    key: 'Pi/vendor/model',
    calls: 1,
    missing: 0,
    cache_missing: 0,
    unpriced: 0,
    input: 10,
    output: 2,
    cache_read: 1,
    cache_write: 0,
    estimated_usd: 0.0001,
  };
  panel.receive({
    type: 'management',
    request_id: 'request_id' in stats ? stats.request_id : 0,
    data: {
      ...data,
      groups: [row],
      totals: { ...row, key: 'total' },
      next_cursor: 'Pi/vendor/model',
    },
  });
  expect(dom.window.document.querySelectorAll('.stats-card')).toHaveLength(4);
  click('下一页统计');
  expect(sent.at(-1)).toMatchObject({
    type: 'read_management',
    query: { cursor: 'Pi/vendor/model' },
  });
  dom.window.close();
});

it('shares Pi defaults across model aliases, preserves explicit overrides and saves context/prices/multiplier together', () => {
  const dom = new JSDOM('<main></main>');
  vi.stubGlobal('document', dom.window.document);
  const sent: UiCommand[] = [];
  const panel = new ManagementPanel(
    (m) => sent.push(m),
    () => {},
  );
  dom.window.document.body.append(panel.root);
  const view = emptyView();
  const model = 'wwzz/gpt-6.1-sol';
  view.catalogue.models = [{ id: model as never, name: 'gpt-6.1-sol' }];
  panel.setView(view, [], []);
  panel.openModels();
  const base: ManagementData = {
    naming_policy: 'off',
    title_model: null,
    groups: [],
    totals: null,
    next_cursor: null,
    models: [
      {
        harness: 'Pi',
        model: 'openai/GPT-6.1 Sol',
        hidden: false,
        price: null,
        default_price: { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
        context_window: 272000,
        default_context_window: 272000,
        multiplier: 1,
      },
    ],
  };
  const receive = (data: ManagementData) => {
    const q = sent.at(-1)!;
    panel.receive({ type: 'management', request_id: 'request_id' in q ? q.request_id : 0, data });
  };
  receive(base);
  const input = (label: string) =>
    dom.window.document.querySelector<HTMLInputElement>(`[aria-label="${model} ${label}"]`)!;
  const click = (label: string) =>
    [...dom.window.document.querySelectorAll<HTMLElement>(`[data-model="Pi:${model}"] button`)]
      .find((n) => n.getAttribute('aria-label') === label)!
      .click();
  expect(input('input price').value).toBe('2');
  expect(input('context k tokens').value).toBe('272');
  expect(input('price multiplier').value).toBe('1');
  for (const [label, value] of [
    ['input price', '3'],
    ['context k tokens', '1000'],
    ['price multiplier', '0.4'],
  ]) {
    input(label).value = value;
    input(label).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  click('保存模型设置');
  expect(sent.at(-1)).toMatchObject({
    command: {
      action: {
        action: 'model_config',
        model,
        context_window: 1000000,
        apply_context: true,
        multiplier: 0.4,
        price: { input: 3, output: 12, cache_read: 0.2, cache_write: 0 },
      },
    },
  });
  let n = 0;
  const confirmed = (data: ManagementData) => {
    panel.setView(
      view,
      [],
      [
        {
          operation: `save-${++n}` as never,
          method: 'manage',
          session: view.id,
          status: 'completed',
        },
      ],
    );
    receive(data);
  };
  const override = {
    harness: 'Pi' as const,
    model,
    hidden: false,
    price: { input: 3, output: 12, cache_read: 0.2, cache_write: 0 },
    default_price: { input: 2, output: 12, cache_read: 0.2, cache_write: 0 },
    context_window: 1000000,
    context_override: 1000000,
    context_state: 'applied' as const,
    default_context_window: 272000,
    multiplier: 0.4,
  };
  confirmed({ ...base, models: [...base.models, override] });
  expect(input('input price').value).toBe('3');
  expect(input('context k tokens').value).toBe('1000');
  expect(input('price multiplier').value).toBe('0.4');
  click('恢复模型默认设置');
  expect(sent.at(-1)).toMatchObject({
    command: {
      action: {
        action: 'model_config',
        price: null,
        multiplier: 1,
        context_window: null,
        apply_context: true,
      },
    },
  });
  confirmed({
    ...base,
    models: [
      ...base.models,
      { ...override, price: null, context_window: 272000, context_override: null, multiplier: 1 },
    ],
  });
  expect(input('input price').value).toBe('2');
  expect(input('context k tokens').value).toBe('272');
  expect(input('price multiplier').value).toBe('1');
  const before = sent.length;
  input('price multiplier').value = '-1';
  click('保存模型设置');
  expect(sent).toHaveLength(before);
  expect(dom.window.document.body.textContent).toContain('价格倍率必须');
  dom.window.close();
});
