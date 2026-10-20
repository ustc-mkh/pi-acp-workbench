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
      .find((n) => n.textContent === name)!
      .click();
  click('Apply Pi context explicitly');
  expect(sent.at(-1)).toMatchObject({
    type: 'execute',
    command: {
      method: 'manage',
      action: { action: 'context', model: 'vendor/model', context_window: 256000 },
    },
  });
  click('Save prices / visibility');
  expect(sent.at(-1)).toMatchObject({
    command: { action: { action: 'model', price: { cache_read: 0.1, cache_write: 1 } } },
  });
  click('Hide provider');
  expect(sent.at(-1)).toMatchObject({
    command: { action: { action: 'visibility', models: ['vendor/model'], hidden: true } },
  });
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
  expect(dom.window.document.body.textContent).toContain('Filtered total');
  click('Next statistics page');
  expect(sent.at(-1)).toMatchObject({
    type: 'read_management',
    query: { cursor: 'Pi/vendor/model' },
  });
  dom.window.close();
});
