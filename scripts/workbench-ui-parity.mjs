// v1.0.0 vs production v3 page, identical fixtures/viewport/theme. No host/model/Bot.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { build } from 'esbuild';
const output = resolve('.test-results/ui-parity');
await mkdir(output, { recursive: true });
const { values } = parseArgs({ options: { baseline: { type: 'string' } } });
if (!values.baseline)
  throw Error('Pass --baseline with the extracted v1.0.0 extension/dist directory');
const old = resolve(values.baseline);
const bundle = await build({
  entryPoints: ['test/helpers/workbench-peer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  external: ['vitest'],
});
const { emptyView } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const prose = '我想把插件恢复成原版的阅读和操作体验。';
const answer =
  '## 保留熟悉的工作方式\n\n先把注意力放回对话本身：紧凑工具栏、独立历史列表，以及固定在底部的输入区。\n\n- 设置按需打开，不再挤占对话空间。\n- 思考与工具调用收起展示。\n- 保留草稿、停止、授权和原生分支。\n\n```ts\nconst message = await agent.reply(prompt);\nconsole.log(message);\n```\n\n支持 **Markdown**、表格和公式 $E=mc^2$。';
const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const management = {
  naming_policy: 'follow',
  title_model: null,
  models: [
    {
      harness: 'Pi',
      model: 'gpt-6.1',
      hidden: false,
      price: null,
      default_price: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
      context_window: 200000,
    },
  ],
  groups: [
    {
      key: 'Pi/gpt-6.1',
      label: 'GPT-6.1',
      calls: 1,
      missing: 0,
      cache_missing: 0,
      unpriced: 0,
      input: 100,
      output: 20,
      cache_read: 10,
      cache_write: 5,
      estimated_usd: 0.000156,
    },
  ],
  totals: {
    key: 'total',
    calls: 1,
    missing: 0,
    cache_missing: 0,
    unpriced: 0,
    input: 100,
    output: 20,
    cache_read: 10,
    cache_write: 5,
    estimated_usd: 0.000156,
  },
  next_cursor: null,
};
function state(kind, scenario) {
  if (kind === 'old')
    return {
      modelContexts: { 'gpt-6.1': 200000 },
      nativeForks: { u1: true, a1: true },
      statistics: {
        titles: {},
        available: true,
        records: [
          {
            id: 'call1',
            model: 'gpt-6.1',
            sessionId: 'ui-parity',
            timestamp: 1792771200000,
            input: 100,
            output: 20,
            cacheRead: 10,
            cacheWrite: 5,
          },
        ],
        models: [{ id: 'gpt-6.1', name: 'GPT-6.1' }],
        prices: { 'gpt-6.1': price },
        sessionNumbers: { 'ui-parity': 1 },
      },
      status: 'ready',
      harness: 'pi',
      connectionAttempted: true,
      sessionId: scenario === 'empty' ? undefined : 'ui-parity',
      sessionNumber: 1,
      sessionTitle: '恢复原版界面',
      agent: 'Pi Agent',
      entries:
        scenario === 'empty'
          ? []
          : [
              { id: 'u1', turnId: 't1', role: 'user', text: prose, messageId: 'm1' },
              { id: 'a1', turnId: 't1', role: 'assistant', text: answer, messageId: 'm2' },
            ],
      attachments: [],
      commands: [],
      plan: [],
      history:
        scenario === 'empty'
          ? []
          : [
              {
                id: 'ui-parity',
                cwd: '/workspace',
                title: '恢复原版界面',
                updated: Date.now(),
                harness: 'pi',
                sessionNumber: 1,
              },
            ],
      permissions: [],
      showThoughts: true,
      preview: false,
      usage: { used: 12000, size: 200000 },
      configs:
        scenario === 'empty'
          ? []
          : [
              {
                id: 'model',
                name: '模型',
                type: 'select',
                currentValue: 'gpt-6.1',
                options: [{ value: 'gpt-6.1', name: 'GPT-6.1' }],
              },
              {
                id: 'thinking',
                name: '思考',
                type: 'select',
                currentValue: 'low',
                options: [{ value: 'low', name: 'Low' }],
              },
            ],
    };
  const v = emptyView();
  v.catalogue.models = [{ id: 'gpt-6.1', name: 'GPT-6.1' }];
  v.catalogue.current_model = 'gpt-6.1';
  v.catalogue.selects = [
    {
      id: 'thinking',
      name: '思考',
      category: 'thought_level',
      current_value: 'low',
      choices: [{ value: 'low', name: 'Low' }],
    },
  ];
  v.usage.context_used = 12000;
  v.usage.context_size = 200000;
  const entries = [
    {
      id: 'u1',
      turn: 't1',
      role: 'User',
      seq: 1,
      message: 'm1',
      text: { Inline: { text: prose } },
      image: null,
    },
    {
      id: 'a1',
      turn: 't1',
      role: 'Agent',
      seq: 2,
      message: 'm2',
      text: { Inline: { text: answer } },
      image: null,
    },
  ];
  return {
    sessions:
      scenario === 'empty'
        ? []
        : [
            {
              id: v.id,
              harness: 'Pi',
              cwd: v.cwd,
              status: 'Idle',
              revision: 1,
              created_seq: 1,
              title: '恢复原版界面',
            },
          ],
    selected: scenario === 'empty' ? undefined : v.id,
    view:
      scenario === 'empty'
        ? undefined
        : { status: 'ready', view: v, entries, tools: [], historical: false },
    operations: [],
    trusted: true,
    workspace: '/workspace',
  };
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean),
      kind = parts.shift();
    if (!['old', 'new'].includes(kind)) throw Error('path');
    if (parts[0] === 'page') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/${kind}/style.css"><link rel="stylesheet" href="/${kind}/katex.min.css"><style>:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-sideBar-background:#151719;--vscode-foreground:#dfdfdf;--vscode-descriptionForeground:#999;--vscode-widget-border:#34383d;--vscode-input-background:#22262a;--vscode-button-background:#387d70;--vscode-focusBorder:#76bfa9}body{background:#151719}</style><script>window.__management=${JSON.stringify(management)};window.__sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>{window.__sent.push(m);if(m.type==='read_management')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'management',request_id:m.request_id,data:window.__management}})),0)},getState:()=>undefined,setState:()=>{}});</script></head><body><${kind === 'old' ? 'div id="app"' : 'main id="workbench"'}></${kind === 'old' ? 'div' : 'main'}><script type="module" src="/${kind}/webview.js"></script></body></html>`,
      );
      return;
    }
    const path = resolve(kind === 'old' ? old : 'dist', ...parts);
    const root = resolve(kind === 'old' ? old : 'dist');
    if (!path.startsWith(root + '/')) throw Error('path');
    const body = await readFile(path);
    res.setHeader(
      'Content-Type',
      { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(path)] ||
        'application/octet-stream',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const report = [];
try {
  for (const kind of ['old', 'new'])
    for (const scenario of [
      'empty',
      'conversation',
      'history',
      'models',
      'models-expanded',
      'statistics',
      'activity',
      'running',
      'todo',
      'permission',
    ])
      for (const width of [320, 460]) {
        const page = await browser.newPage({
          viewport: { width, height: 940 },
          colorScheme: 'dark',
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/${kind}/page`);
        await page.waitForFunction(() => window.__sent?.some((x) => x.type === 'ready'));
        await page.evaluate(
          ({ kind, state }) =>
            window.dispatchEvent(
              new MessageEvent('message', {
                data:
                  kind === 'old'
                    ? { type: 'state', revision: 1, state }
                    : { type: 'state', sequence: 1, state },
              }),
            ),
          { kind, state: state(kind, scenario) },
        );
        await page.waitForTimeout(100);
        if (['activity', 'running', 'todo', 'permission'].includes(scenario)) {
          const fixture = state(kind, scenario);
          if (kind === 'old') {
            if (scenario === 'activity')
              fixture.entries.splice(1, 0, {
                id: 'thought',
                turnId: 't1',
                role: 'thought',
                text: '先核对原版布局。',
                messageId: 'mt',
              });
            if (scenario === 'todo')
              fixture.plan = [
                { content: '核对原版界面', status: 'in_progress' },
                { content: '检查操作流程', status: 'pending' },
              ];
            if (scenario === 'running' || scenario === 'permission') {
              fixture.status = 'busy';
              fixture.activeTurnId = 't1';
            }
            if (scenario === 'permission')
              fixture.permissions = [
                {
                  id: 'permission',
                  request: {
                    toolCall: { title: '写入文件' },
                    options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
                  },
                },
              ];
          } else {
            if (scenario === 'activity')
              fixture.view.entries.splice(1, 0, {
                id: 'thought',
                turn: 't1',
                seq: 3,
                role: 'Thought',
                text: { Inline: { text: '先核对原版布局。' } },
                message: 'mt',
                image: null,
              });
            if (scenario === 'todo')
              fixture.view.view.plan = {
                items: [
                  { description: '核对原版界面', status: 'InProgress' },
                  { description: '检查操作流程', status: 'Pending' },
                ],
              };
            if (scenario === 'running' || scenario === 'permission') {
              fixture.view.view.status = scenario === 'permission' ? 'Waiting' : 'Running';
              fixture.view.view.active_turn = 't1';
            }
            if (scenario === 'permission')
              fixture.view.view.pending_interactions = {
                permission: {
                  id: 'permission',
                  kind: 'Permission',
                  title: '写入文件',
                  detail: JSON.stringify({ title: '写入文件' }, null, 2),
                  options: [{ id: 'allow-once', label: '允许一次' }],
                  fields: [],
                  expires_at: null,
                },
              };
          }
          await page.evaluate(
            ({ kind, state }) =>
              window.dispatchEvent(
                new MessageEvent('message', {
                  data:
                    kind === 'old'
                      ? { type: 'state', revision: 2, state }
                      : { type: 'state', sequence: 2, state },
                }),
              ),
            { kind, state: fixture },
          );
        }
        if (scenario === 'history')
          await page.getByRole('button', { name: '历史记录', exact: true }).click();
        if (scenario.startsWith('models')) {
          await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
          await page.locator('.provider-group').first().waitFor();
          if (scenario.endsWith('expanded'))
            await page.locator('.provider-group > summary').first().click();
        }
        if (scenario === 'statistics')
          await page.getByRole('button', { name: '用量统计', exact: true }).first().click();
        await page.mouse.move(width - 2, 938);
        await page.waitForTimeout(100);
        const screenshot = join(output, `${kind}-${scenario}-${width}.png`);
        await page.screenshot({ path: screenshot });
        if (kind === 'new')
          assert(
            !((await page.locator('#error').textContent()) || '').includes('Invalid workbench'),
            `${scenario} invalid fixture`,
          );
        assert.deepEqual(errors, [], `${kind}/${scenario}/${width} browser errors`);
        report.push({
          kind,
          scenario,
          width,
          errors,
          screenshot,
          geometry: await page.evaluate(() => ({
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            bodyHeight: document.body.scrollHeight,
            viewport: innerHeight,
            header: document.querySelector('header')?.getBoundingClientRect().toJSON(),
            composer: document.querySelector('footer')?.getBoundingClientRect().toJSON(),
            articles: [...document.querySelectorAll('article')]
              .filter((x) => x.getBoundingClientRect().width > 0 && !x.closest('.activity-group'))
              .map((x) => x.getBoundingClientRect().toJSON()),
          })),
        });
        await page.close();
      }
  // Chromium can retain layout boxes inside a closed details element; compare the
  // conversation articles, and let screenshot pixels cover collapsed activity groups.
  await (
    await import('node:fs/promises')
  ).writeFile(join(output, 'screens.json'), JSON.stringify(report, null, 2));
  const comparisons = [];
  for (const scenario of ['empty', 'conversation', 'activity', 'todo'])
    for (const width of [320, 460]) {
      const before = report.find(
          (x) => x.kind === 'old' && x.scenario === scenario && x.width === width,
        ),
        after = report.find(
          (x) => x.kind === 'new' && x.scenario === scenario && x.width === width,
        );
      for (const key of ['header', 'composer'])
        for (const field of ['x', 'y', 'width', 'height'])
          assert(
            Math.abs(before.geometry[key][field] - after.geometry[key][field]) <= 2,
            `${scenario}/${width} ${key}.${field} differs`,
          );
      for (let i = 0; i < before.geometry.articles.length; i++)
        for (const field of ['x', 'y', 'width', 'height'])
          assert(
            Math.abs(before.geometry.articles[i][field] - after.geometry.articles[i][field]) <= 2,
            `${scenario}/${width} article${i}.${field} differs`,
          );
      const pixel = await browser.newPage();
      const diff = await pixel.evaluate(
        async ({ a, b }) => {
          const load = async (src) => {
            const im = new Image();
            im.src = src;
            await im.decode();
            const c = document.createElement('canvas');
            c.width = im.width;
            c.height = im.height;
            c.getContext('2d').drawImage(im, 0, 0);
            return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          };
          const x = await load(a),
            y = await load(b);
          let changed = 0;
          for (let i = 0; i < x.length; i += 4)
            if (
              Math.max(
                Math.abs(x[i] - y[i]),
                Math.abs(x[i + 1] - y[i + 1]),
                Math.abs(x[i + 2] - y[i + 2]),
              ) > 32
            )
              changed++;
          return changed / (x.length / 4);
        },
        {
          a: 'data:image/png;base64,' + (await readFile(before.screenshot)).toString('base64'),
          b: 'data:image/png;base64,' + (await readFile(after.screenshot)).toString('base64'),
        },
      );
      await pixel.close();
      comparisons.push({ scenario, width, changedPixelRatio: diff });
      assert(
        diff < 0.01,
        `${scenario}/${width} changed pixels ${(diff * 100).toFixed(2)}% exceed 1%`,
      );
    }
  await (
    await import('node:fs/promises')
  ).writeFile(
    join(output, 'report.json'),
    JSON.stringify({ screens: report, comparisons }, null, 2),
  );
  console.log(JSON.stringify(comparisons));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
