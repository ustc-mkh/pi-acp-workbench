import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const demoBundle = await build({
  entryPoints: ['src/demo.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { demoMarkdown } = await import(
  'data:text/javascript;base64,' + Buffer.from(demoBundle.outputFiles[0].text).toString('base64')
);
const channelBundle = await build({
  entryPoints: ['src/state-channel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { StateEncoder } = await import(
  'data:text/javascript;base64,' + Buffer.from(channelBundle.outputFiles[0].text).toString('base64')
);
const encoder = new StateEncoder();
const artifacts = resolve('test-results/browser');
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const file = resolve('dist', '.' + req.url);
    if (!file.startsWith(resolve('dist') + '/')) throw new Error('Path');
    const body = await readFile(file);
    res.setHeader(
      'Content-Type',
      { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] ||
        'application/octet-stream',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const executablePath =
    process.env.CHROME_PATH ||
    (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath());
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({
    viewport: { width: 460, height: 940 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const scripts = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/style.css');
  await page.setContent(
    /* HTML */ `<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; script-src 'nonce-smoke' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src ${origin} data:; connect-src 'none';"
          />
          <link rel="stylesheet" href="${origin}/katex.min.css" />
          <link rel="stylesheet" href="${origin}/style.css" />
        </head>
        <body>
          <div id="app"></div>
        </body>
      </html>`,
  );
  // Reproduce the VS Code Webview defaults, including inherited standard
  // scrollbar-color (which overrides WebKit pseudo-elements in Chromium).
  await page.addStyleTag({
    content: `html { scrollbar-color: #888888 #112233; }
    ::-webkit-scrollbar { width:10px; height:10px; }
    ::-webkit-scrollbar-corner { background-color:#112233; }
    ::-webkit-scrollbar-thumb { background-color:#888888; }`,
  });
  await page.evaluate(() => {
    window.messages = [];
    window.savedState = {};
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.messages.push(m),
      getState: () => window.savedState,
      setState: (state) => {
        window.savedState = state;
      },
    });
  });
  await page.addScriptTag({ url: origin + '/webview.js', type: 'module' });
  const state = {
    status: 'disconnected',
    entries: [],
    attachments: [],
    commands: [],
    plan: [],
    history: [],
    permissions: [],
    showThoughts: true,
    preview: false,
  };
  const emit = async (s) => {
    await page.evaluate((message) => window.postMessage(message, '*'), encoder.encode(s));
    await page.waitForTimeout(75);
  };
  await emit(state);
  assert.equal(await page.locator('header .toolbar #models-toggle').count(), 1);
  assert.equal(await page.locator('footer #models-toggle').count(), 0);
  assert.equal(await page.locator('#copy-conversation').count(), 0);
  assert(!scripts.some((url) => /mermaid/i.test(url)), 'Mermaid loaded before any diagram');
  const inputHeight = await page
    .locator('#input')
    .evaluate((node) => node.getBoundingClientRect().height);
  const separator = await page.locator('#composer-resizer').boundingBox();
  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(separator.x + separator.width / 2, separator.y - 60, { steps: 5 });
  await page.mouse.up();
  assert(
    (await page.locator('#input').evaluate((node) => node.getBoundingClientRect().height)) >
      inputHeight + 50,
  );
  assert.equal(
    await page.locator('#input').evaluate((node) => getComputedStyle(node).resize),
    'none',
  );
  assert.equal(
    await page
      .locator('#input')
      .evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar-button').display),
    'none',
  );
  for (const selector of ['html', '#transcript', '#input', '#history-items', '#statistics']) {
    assert.equal(
      await page.locator(selector).evaluate((node) => getComputedStyle(node).scrollbarColor),
      'auto',
    );
    assert.equal(
      await page
        .locator(selector)
        .evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar').width),
      '6px',
    );
    assert.equal(
      await page
        .locator(selector)
        .evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar-track').backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
  }
  assert.equal(
    await page.locator('#transcript').evaluate((node) => node.offsetWidth - node.clientWidth),
    6,
  );
  assert((await page.evaluate(() => window.savedState.composerHeight)) > 100);
  assert(await page.locator('#start-session').isVisible());
  await page.locator('#start-session').click();
  assert((await page.evaluate(() => window.messages)).some((m) => m.type === 'new'));
  assert(!(await page.evaluate(() => window.messages)).some((m) => m.type === 'connect'));
  await page.getByText('预览 Markdown 与公式').click();
  assert((await page.evaluate(() => window.messages)).some((m) => m.type === 'preview'));
  state.preview = true;
  state.entries = [{ id: 'demo', role: 'assistant', text: demoMarkdown }];
  await emit(state);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.diagram-canvas[data-rendered="true"] svg').waitFor();
  assert(
    scripts.some((url) => /mermaid/i.test(url)),
    'Mermaid lazy chunk was not fetched',
  );
  assert.equal(await page.locator('.diagram-error').count(), 0);
  assert((await page.locator('.katex').count()) >= 7);
  assert.equal(await page.locator('.math-fallback').count(), 0);
  await page.evaluate(() => {
    document.querySelector('#transcript').scrollTop = 0;
  });
  await page.screenshot({ path: resolve(artifacts, 'preview-dark.png') });
  await page.setViewportSize({ width: 320, height: 740 });
  await emit(state);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addStyleTag({
    content:
      ':root{--bg:#fafafa;--fg:#242424;--muted:#666;--border:#ddd;--input:#f0f0f0;--vscode-textCodeBlock-background:#f3f3f3}',
  });
  await page.evaluate(() => {
    document.querySelector('#transcript').scrollTop = 0;
  });
  await page.screenshot({ path: resolve(artifacts, 'preview-light.png') });
  state.preview = false;
  state.status = 'ready';
  await emit(state);
  await page.locator('#transcript').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  assert(await page.locator('#bottom').isVisible());
  await page.locator('#input').fill('推导这个公式');
  await page.locator('#input').press('Enter');
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'send' && m.text === '推导这个公式',
    ),
  );
  assert(
    await page
      .locator('#transcript')
      .evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop < 2),
  );
  assert(await page.locator('#bottom').isHidden());
  await page.evaluate(() => window.postMessage({ type: 'sent' }, '*'));
  await page.waitForTimeout(40);
  assert.equal(await page.locator('#input').inputValue(), '');
  state.status = 'busy';
  state.entries = [{ id: 'stream', role: 'assistant', text: '$$\\frac{1}' }];
  await emit(state);
  state.entries[0] = { ...state.entries[0], text: state.entries[0].text + '{2}$$' };
  await emit(state);
  assert.equal(await page.locator('.katex').count(), 1);
  state.permissions = [
    {
      id: 'p1',
      request: {
        sessionId: 's',
        toolCall: { title: 'Edit test.ts', toolCallId: 't1' },
        options: [{ optionId: 'deny-1', name: '拒绝本次', kind: 'reject_once' }],
      },
    },
  ];
  await emit(state);
  await page.getByText('拒绝本次', { exact: true }).click();
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'permission' && m.optionId === 'deny-1',
    ),
  );
  await page.locator('#stop').click();
  assert((await page.evaluate(() => window.messages)).some((m) => m.type === 'cancel'));
  state.permissions = [];
  state.entries = [
    { id: 'live-user', role: 'user', text: '检查代码' },
    { id: 'live-narration', role: 'assistant', text: '我先检查实现。' },
    { id: 'live-thought', role: 'thought', text: '思考' },
    {
      id: 'live-tool',
      role: 'tool',
      tool: { toolCallId: 'read', title: 'Read', status: 'completed' },
    },
    { id: 'live-next', role: 'assistant', text: '已找到原因，正在修复。' },
    {
      id: 'live-tool2',
      role: 'tool',
      tool: { toolCallId: 'edit2', title: 'Edit', status: 'in_progress' },
    },
  ];
  await emit(state);
  assert.equal(await page.locator('#messages > .message.assistant:visible').count(), 2);
  assert.equal(await page.locator('#messages > .activity-group').count(), 2);
  assert(await page.locator('#new').isEnabled());
  assert(await page.locator('#harness-switch').isEnabled());
  await page.screenshot({ path: resolve(artifacts, 'preview-live-flow.png') });
  state.entries.push({ id: 'live-final', role: 'assistant', text: '修复完成。' });
  state.status = 'ready';
  await emit(state);
  assert.equal(await page.locator('#messages > .activity-group').count(), 1);
  assert.equal(
    await page.locator('#messages > .activity-group').evaluate((node) => node.open),
    false,
  );
  assert.equal(await page.locator('#messages > .message.assistant:visible').count(), 1);
  assert.equal(
    (await page.locator('#messages > .message.assistant:visible .markdown').textContent()).trim(),
    '修复完成。',
  );
  await page.screenshot({ path: resolve(artifacts, 'preview-settled-flow.png') });
  state.status = 'busy';
  state.entries = [
    {
      id: 'tool',
      role: 'tool',
      tool: {
        toolCallId: 'edit',
        title: 'Edit file',
        status: 'completed',
        content: [{ type: 'diff', path: '/project/test.ts', oldText: 'a', newText: 'b' }],
      },
    },
  ];
  await emit(state);
  assert.equal(await page.locator('.activity-group').evaluate((node) => node.open), false);
  await page.locator('#toggle-activity').click();
  assert.equal(await page.locator('.activity-group').evaluate((node) => node.open), true);
  await page.locator('.message.tool > summary').click();
  await page.getByText('查看修改 · /project/test.ts').click();
  assert(
    (await page.evaluate(() => window.messages)).some((m) => m.type === 'diff' && m.index === 0),
  );
  state.entries.push({ id: 'native-answer', role: 'assistant', text: '可原生回溯的回答' });
  state.entries.push({
    id: 'turn-diff',
    role: 'diff',
    text: '本轮修改',
    diff: {
      status: 'complete',
      warnings: ['本轮工作区净变化；不是回滚点。'],
      files: [
        {
          path: 'test.ts',
          status: 'modified',
          before: 'before\n',
          after: 'after\n',
          added: 1,
          removed: 1,
          patch: '@@ -1 +1 @@\n-before\n+after\n',
        },
      ],
    },
  });
  await emit(state);
  assert.equal(await page.locator('#messages > .turn-diff').count(), 1);
  assert.equal(await page.locator('.activity-body .turn-diff').count(), 0);
  await page.getByText('查看总 Diff', { exact: true }).click();
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'diff' && m.id === 'turn-diff' && m.index === -1,
    ),
  );
  assert.equal(await page.locator('.turn-diff-files').evaluate((node) => node.open), false);
  assert(await page.locator('.turn-diff-notes').isHidden());
  await page.locator('.turn-diff-files > summary').click();
  assert(await page.locator('.turn-diff-notes').isVisible());
  await page.locator('.turn-diff-file > summary').click();
  await page.getByText('在编辑器中对比', { exact: true }).click();
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'diff' && m.id === 'turn-diff' && m.index === 0,
    ),
  );
  assert.equal(await page.locator('.turn-diff .diff-add').count(), 1);
  assert.equal(await page.locator('.turn-diff .diff-remove').count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(artifacts, 'preview-turn-diff.png') });
  state.nativeForks = { 'native-answer': { entryId: 'native-node', hash: 'verified' } };
  state.history = [
    { id: 's1', sessionNumber: 1, title: '相同标题', cwd: '/project', updated: 2 },
    { id: 's2', sessionNumber: 2, title: '相同标题', cwd: '/project', updated: 1 },
  ];
  state.sessionId = 's1';
  state.sessionNumber = 1;
  state.status = 'ready';
  await emit(state);
  await page.locator('#history-toggle').click();
  assert.deepEqual(await page.locator('#history-items .session-number').allTextContents(), [
    '#001',
    '#002',
  ]);
  assert.equal(await page.locator('#session-number').textContent(), '#001');
  state.history.push(
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `older${i}`,
      sessionNumber: i + 3,
      title: `更早的会话 ${i}`,
      cwd: '/project',
      updated: -i,
    })),
  );
  state.status = 'busy';
  await emit(state);
  assert.equal(await page.locator('#history-items .history-row').count(), 4);
  await page.locator('.history-more').click();
  assert.equal(await page.locator('#history-items .history-row').count(), 7);
  await page.screenshot({ path: resolve(artifacts, 'preview-history-expanded.png') });
  await page.locator('#history-items [data-id="older4"] .history-open').click();
  assert(await page.locator('#history').isVisible());
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'resume' && m.id === 'older4',
    ),
  );
  state.status = 'connecting';
  await emit(state);
  assert(await page.locator('#history').isVisible());
  assert.equal(await page.locator('#history-items .history-row').count(), 7);
  state.status = 'ready';
  await emit(state);
  await page.locator('.history-more').click();
  assert.equal(await page.locator('#history-items .history-row').count(), 4);
  assert(await page.locator('#history').isVisible());
  await page.locator('#history-toggle').click();
  state.commands = [];
  await emit(state);
  await page.locator('#input').fill('/');
  assert(await page.locator('#commands').isVisible());
  state.commands = Array.from({ length: 20 }, (_, i) => ({
    name: `command${i}`,
    description: 'ACP command',
  }));
  await emit(state);
  assert.equal(await page.locator('#commands button').count(), 20);
  assert(
    await page
      .locator('#commands button')
      .first()
      .evaluate((button) => {
        const r = button.getBoundingClientRect();
        return !!document
          .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          ?.closest('#commands');
      }),
  );
  const popup = await page.locator('#commands').boundingBox(),
    field = await page.locator('#input').boundingBox();
  assert(popup.y >= 0 && popup.y + popup.height <= field.y);
  await page.screenshot({ path: resolve(artifacts, 'preview-command-menu.png') });
  const sentBefore = await page.evaluate(
    () => window.messages.filter((m) => m.type === 'send').length,
  );
  for (let i = 0; i < 12; i++) await page.locator('#input').press('ArrowDown');
  await page.locator('#input').press('Enter');
  assert.equal(await page.locator('#input').inputValue(), '/command12 ');
  assert.equal(
    await page.evaluate(() => window.messages.filter((m) => m.type === 'send').length),
    sentBefore,
  );
  await page.locator('#input').fill('/command19');
  await page.locator('#commands button').click();
  assert.equal(await page.locator('#input').inputValue(), '/command19 ');
  await page.locator('#input').fill('/');
  await page.locator('#input').press('Escape');
  await emit(state);
  assert(await page.locator('#commands').isHidden());
  await page.locator('#input').fill('Pi private draft');
  await page.locator('#harness-switch').selectOption('codex');
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'switchHarness' && m.harness === 'codex',
    ),
  );
  state.configs = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'm',
      options: [{ value: 'm', name: 'Model' }],
    },
    {
      id: 'reasoning',
      name: 'Reasoning',
      type: 'select',
      currentValue: 'high',
      options: [{ value: 'high', name: 'High' }],
    },
    {
      id: 'mode',
      name: 'Permissions',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [{ value: 'ask', name: 'Ask' }],
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      description: '请求优先级服务，可能增加费用；需模型和账户支持。',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
  state.contextComplete = true;
  state.harness = 'codex';
  state.sessionId = 'workbench:codex:s1';
  await emit(state);
  assert.equal(await page.locator('#selectors select').count(), 4);
  assert.equal(await page.locator('#selectors select[aria-label="Fast mode"]').count(), 1);
  assert.equal(await page.locator('#selectors select[aria-label="Collaboration mode"]').count(), 0);
  assert.equal(await page.locator('.message.tool [data-context-action]').count(), 0);
  assert.equal(await page.locator('#input').inputValue(), '');
  assert.equal(await page.locator('#harness-switch').inputValue(), 'codex');
  assert(await page.locator('#harness-help').isVisible());
  assert(await page.locator('[data-context-action]').first().isDisabled());
  await page.locator('#input').fill('Codex private draft');
  state.harness = 'pi';
  state.sessionId = 's1';
  await emit(state);
  assert.equal(await page.locator('#input').inputValue(), 'Pi private draft');
  assert(await page.locator('[data-context-action]').first().isEnabled());
  await page.locator('[data-context-action]').first().click();
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'branchMessage' && m.id === 'native-answer' && m.sessionId === 's1',
    ),
  );
  state.status = 'connecting';
  state.contextOperation = { kind: 'fork' };
  await emit(state);
  assert(await page.locator('#context-operation').isVisible());
  assert.equal(await page.locator('#context-progress').textContent(), '正在创建原生分支…');
  assert(await page.locator('#stop').isHidden());
  await page.locator('#cancel-context').click();
  assert((await page.evaluate(() => window.messages)).some((m) => m.type === 'cancelContext'));
  state.contextOperation = undefined;
  state.harness = 'codex';
  state.sessionId = 'workbench:codex:s1';
  state.status = 'busy';
  await emit(state);
  assert.equal(await page.locator('#input').inputValue(), 'Codex private draft');
  assert(await page.locator('#harness-switch').isEnabled());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  state.status = 'ready';
  await emit(state);
  const readyBefore = await page.evaluate(
    () => window.messages.filter((m) => m.type === 'ready').length,
  );
  await page.evaluate(() =>
    window.postMessage(
      { type: 'statePatch', revision: 999, fields: {}, unset: [], entries: [] },
      '*',
    ),
  );
  await page.waitForTimeout(75);
  assert.equal(
    await page.evaluate(() => window.messages.filter((m) => m.type === 'ready').length),
    readyBefore + 1,
  );
  encoder.reset();
  await emit(state);
  assert.equal(await page.locator('.message.tool').count(), 1);
  state.status = 'ready';
  await emit(state);
  await page.locator('#selectors select[aria-label="Fast mode"]').selectOption('on');
  assert(
    (await page.locator('.selector-fast').getAttribute('data-tooltip')).includes('可能增加费用'),
  );
  await page.screenshot({ path: resolve(artifacts, 'preview-pi-fast.png') });
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'config' && m.id === 'fast-mode' && m.value === 'on',
    ),
  );
  state.configs[0].options = [
    { value: 'm', name: 'Current Model' },
    { value: 'other', name: 'Other Model' },
    { value: 'hidden', name: 'Hidden Model' },
  ];
  state.visibleModels = ['other'];
  await emit(state);
  assert.equal(await page.locator('#selectors select[aria-label="Model"] option').count(), 2);
  await page.locator('#models-toggle').click();
  assert(await page.locator('#models').isVisible());
  assert.equal(await page.locator('#models input[type="checkbox"]').count(), 3);
  await page.locator('#models input[type="search"]').fill('Hidden');
  assert.equal(await page.locator('#models .model-row:visible').count(), 1);
  await page.locator('#models input[value="hidden"]').check();
  assert(
    (await page.evaluate(() => window.messages)).some(
      (m) => m.type === 'setVisibleModels' && m.harness === 'codex' && m.models.includes('hidden'),
    ),
  );
  await page.screenshot({ path: resolve(artifacts, 'preview-models.png') });
  await page.locator('#models button').first().click();
  state.entries = state.entries.map((entry) =>
    entry.role === 'tool'
      ? { ...entry, terminal: { id: 'terminal', output: 'line\n'.repeat(200) } }
      : entry,
  );
  await emit(state);
  const terminal = page.locator('.terminal-output');
  if (
    !(await page
      .locator('.activity-group')
      .first()
      .evaluate((node) => node.open))
  )
    await page.locator('.activity-group summary').first().click();
  if (
    !(await page
      .locator('.message.tool')
      .first()
      .evaluate((node) => node.open))
  )
    await page.locator('.message.tool summary').first().click();
  await terminal.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  state.entries = state.entries.map((entry) =>
    entry.role === 'tool'
      ? { ...entry, terminal: { ...entry.terminal, output: entry.terminal.output + 'new line\n' } }
      : entry,
  );
  await emit(state);
  assert(
    await terminal.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 24),
  );
  await terminal.evaluate((node) => {
    node.scrollTop = 0;
  });
  state.entries = state.entries.map((entry) =>
    entry.role === 'tool'
      ? {
          ...entry,
          terminal: { ...entry.terminal, output: entry.terminal.output + 'another line\n' },
        }
      : entry,
  );
  await emit(state);
  assert.equal(await terminal.evaluate((node) => node.scrollTop), 0);
  await page.screenshot({ path: resolve(artifacts, 'preview-terminal.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: lazy Mermaid under CSP, dark/light math, narrow viewport, incremental state, resynchronization, streamed math, activity folding, separator drag, quiet scrollbars, harness selection/draft isolation, unclipped slash commands and keyboard selection, send, permission, cancel, per-tool/per-turn diffs, model visibility, Fast mode, following terminal output, no runtime errors.',
  );
} finally {
  await browser?.close();
  server.close();
}
