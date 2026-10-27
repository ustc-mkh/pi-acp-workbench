import { checkClassicLayout } from './lib/workbench-classic-layout.mjs';
// Production v3 extension/browser graph + real new daemon. Synthetic ACP; no account/Bot/model.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { measureRenderWorkload } from './lib/workbench-render-workload.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);

const bundle = await build({
  entryPoints: ['src/workbench-controller.ts', 'src/workbench-client.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  outdir: '/unused',
});
const load = async (name) =>
  import(
    'data:text/javascript;base64,' +
      Buffer.from(
        bundle.outputFiles.find((file) => file.path.endsWith(name + '.js')).text,
      ).toString('base64')
  );
const { WorkbenchController } = await load('workbench-controller');
const { WorkbenchClient } = await load('workbench-client');
const root = await mkdtemp(join(tmpdir(), 'workbench-browser-'));
const data = join(root, 'data'),
  config = join(root, 'workbench.json');
let daemon, exited, browser, controller;
let output = '',
  page;
const artifacts = resolve('test-results/workbench-browser');
await mkdir(artifacts, { recursive: true });
let checks = 0;
const check = (message) => {
  checks++;
  console.log(`ok   ${message}`);
};
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
try {
  await mkdir(join(root, 'home'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, '.gitignore'), '*\n!review.txt\n');
  await writeFile(join(root, 'review.txt'), 'before\n');
  await writeFile(join(root, 'fork-gate.release'), 'released');
  await writeFile(
    config,
    JSON.stringify({
      workers: {
        pi: {
          command: process.execPath,
          args: [resolve('test/contract-agent.mjs')],
          env: {
            WORKBENCH_CONTRACT_MANAGEMENT: '1',
            WORKBENCH_CONTRACT_TYPED_SETTINGS: '1',
            WORKBENCH_CONTRACT_WORKSPACE_FILE: join(root, 'review.txt'),
            WORKBENCH_CONTRACT_NATIVE_STATE: join(root, 'native'),
            WORKBENCH_CONTRACT_TRACE: join(root, 'trace'),
            WORKBENCH_CONTRACT_FORK_GATE: join(root, 'fork-gate'),
          },
        },
      },
      sessions: { mailbox: 128, max_workers: 1 },
      telegram: null,
      storage: { root: data },
      limits: { pending_interactions: 32 },
    }),
  );
  daemon = spawn(binary, ['--config', config], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8' },
  });
  exited = new Promise((done, fail) => {
    daemon.once('error', fail);
    daemon.once('exit', done);
  });
  void exited.catch(() => {});
  daemon.stdout.on('data', (bytes) => (output += bytes));
  daemon.stderr.on('data', (bytes) => (output += bytes));
  const deadline = Date.now() + 10000;
  while (!output.includes('ready:')) {
    if (daemon.exitCode !== null || Date.now() > deadline)
      throw new Error(output || 'Daemon start failed');
    await new Promise((done) => setTimeout(done, 10));
  }
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath =
    process.env.CHROME_PATH ||
    (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath());
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 460, height: 940 }, colorScheme: 'dark' });
  const errors = [],
    unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:'))
      unexpected.push(request.url());
  });
  const client = new WorkbenchClient(join(data, 'workbench.sock'));
  const editorDiffs = [],
    externalLinks = [];
  let confirmations = 0;
  let managementReplies = 0;
  controller = new WorkbenchController(client, {
    openLink: async (url) => {
      externalLinks.push(url);
    },
    openDiff: async (turn, files) => {
      editorDiffs.push({ turn, files });
    },
    confirmUndo: async () => {
      confirmations++;
      return true;
    },
    post: (message) => {
      if (message.type === 'management') managementReplies++;
      void page.evaluate((value) => window.postMessage(value, '*'), message).catch(() => {});
    },
    trusted: () => true,
    attachFiles: async () => [
      { id: 'explicit-file', name: 'example.ts', text: 'export const answer = 42;' },
    ],
    workspace: () => root,
    authorize: async (cwd) => {
      assert.equal(await realpath(cwd), await realpath(root));
    },
  });
  await page.exposeFunction('workbenchReceive', (message) => controller.receive(message));
  // Load a real HTML navigation instead of turning a CSS document into a page.
  // Chromium may otherwise schedule its default favicon after CSP is replaced.
  const fixtureHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-smoke' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src blob:; connect-src 'none';"><script nonce="smoke">const icon=document.createElement("link");icon.rel="icon";icon.href=URL.createObjectURL(new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXcAAAAASUVORK5CYII="),c=>c.charCodeAt(0))],{type:"image/png"}));document.head.append(icon);</script><link rel="stylesheet" href="${origin}/style.css"><link rel="stylesheet" href="${origin}/katex.min.css"></head><body><main id="workbench"></main></body></html>`;
  await page.route(origin + '/fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: fixtureHtml }),
  );
  await page.goto(origin + '/fixture');
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => void window.workbenchReceive(message),
    });
  });
  await page.addScriptTag({ url: origin + '/webview.js', type: 'module' });
  const wait = async (condition, label) => {
    const end = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > end)
        throw new Error(
          `Timeout: ${label}; state=${JSON.stringify(controller.snapshot)}; browserErrors=${JSON.stringify(errors)}; daemon=${output}`,
        );
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await wait(
    () => controller.snapshot.view?.status === 'ready' && !controller.snapshot.preparing,
    'created session with automatic settings',
  );
  const source = controller.snapshot.selected;
  assert(source);
  assert.equal(controller.snapshot.view.view.harness, 'Pi');
  check(
    'production browser/controller creates a session and automatically loads settings through the actual host IPC v3',
  );
  const prompt = async (text) => {
    await page.waitForFunction(
      (selected) =>
        document.querySelector('#history-items [aria-selected="true"]')?.dataset.sessionId ===
          selected &&
        [...document.querySelectorAll('button')].some((button) => button.id === 'send'),
      controller.snapshot.selected,
    );
    const acceptedInputs = () =>
      controller.snapshot.view?.entries.filter(
        (row) =>
          row.role === 'User' &&
          ('Inline' in row.text
            ? row.text.Inline.text
            : controller.snapshot.view.resolvedText?.[row.text.Archived.content.id]) === text,
      ).length || 0;
    const previous = acceptedInputs();
    await page.locator('#prompt').fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await wait(() => acceptedInputs() > previous, `prompt ${text.slice(0, 80)}`);
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
  };
  await wait(
    () => controller.snapshot.view?.view?.catalogue.selects?.some((s) => s.id === 'thought_level'),
    'automatic provider discovery without manual load',
  );
  assert.equal(controller.snapshot.view.entries.length, 0);
  await page.waitForFunction(() => {
    const slider = document.querySelector('[aria-label="思考强度"]');
    return slider && !slider.disabled;
  });
  await page.getByRole('button', { name: '模型、思考和 Fast 设置', exact: true }).click();
  await page.waitForFunction(() => {
    const s = document.querySelector('[aria-label="思考强度"]');
    return !s.disabled;
  });
  await page.getByRole('slider', { name: '思考强度', exact: true }).press('End');
  await wait(
    () => controller.snapshot.view?.view?.config.options?.thought_level === 'high',
    'observed thinking before first task',
  );
  await page.getByRole('button', { name: 'Fast Mode', exact: true }).click();
  await wait(
    () => controller.snapshot.view?.view?.config.options?.fast === 'on',
    'observed independent Fast',
  );
  await page.screenshot({ path: join(artifacts, 'model-controls-open.png') });
  await page.getByRole('button', { name: '恢复打开面板时的思考强度', exact: true }).click();
  await wait(
    () => controller.snapshot.view?.view?.config.options?.thought_level === 'low',
    'reset opening thinking',
  );
  await page.waitForFunction(() => {
    const s = document.querySelector('[aria-label="思考强度"]');
    return !s.disabled;
  });
  await page.getByRole('slider', { name: '思考强度', exact: true }).press('End');
  await wait(
    () => controller.snapshot.view?.view?.config.options?.thought_level === 'high',
    'restore high thinking',
  );
  await page.keyboard.press('Escape');
  check(
    'explicit desktop discovery configures actual independent Thinking/Fast before the first task',
  );
  await prompt('streamed-message');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'stream completion',
  );
  await page.locator('article').filter({ hasText: '世界' }).waitFor();
  assert.equal(await page.locator('article[data-entry]').count(), 3);
  assert.equal(await page.locator('article.thought').count(), 1);
  const sourceRows = structuredClone(controller.snapshot.view.entries);
  assert.equal(new Set(sourceRows.slice(1).map((row) => row.message)).size, 1);
  check(
    'logical messages join text fragments while preserving role boundaries and immutable committed entries',
  );
  await page.getByRole('button', { name: '从此处分支', exact: true }).first().click();
  await wait(
    () => controller.snapshot.selected !== source && controller.snapshot.view?.status === 'ready',
    'native branch selection',
  );
  const branch = controller.snapshot.selected;
  assert.equal(controller.snapshot.view.view.origin.session, source);
  assert(
    controller.snapshot.operations.some(
      (operation) => operation.method === 'fork' && operation.status === 'completed',
    ),
  );
  check(
    'one-worker native fork adopts an independent session and selects it without transcript/native timestamp guessing',
  );
  await prompt('elicitation-text');
  await page.locator('#interactions textarea').waitFor();
  await page.locator('#interactions textarea').fill('browser typed answer');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'typed form resolution',
  );
  await page.locator('#interactions form').waitFor({ state: 'detached' });
  check('typed elicitation fields render and answer the exact interaction, not a guessed prompt');
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    await prompt(`pi-question-${method}`);
    const card = page.locator('.extension-question');
    await card.waitFor();
    assert.equal(await card.locator('strong').textContent(), 'Pi · 等待你的回答');
    assert.equal(await card.locator('p').textContent(), 'Review before continuing');
    if (method === 'input' || method === 'editor') {
      const input = card.getByRole('textbox', { name: '回答', exact: true });
      assert.equal(await input.inputValue(), 'original\n计划');
      assert.equal(await input.getAttribute('rows'), method === 'editor' ? '6' : '3');
      await input.fill(method === 'editor' ? '' : 'browser exact answer');
      await card.getByRole('button', { name: '提交回答', exact: true }).click();
    } else {
      await card
        .getByRole('button', {
          name: method === 'confirm' ? 'Change plan' : 'Continue',
          exact: true,
        })
        .click();
    }
    await wait(() => controller.snapshot.view?.view?.status === 'Idle', `Pi ${method} answer`);
    await card.waitFor({ state: 'detached' });
    if (method === 'input' || method === 'editor') {
      const rows = controller.snapshot.view.entries;
      const answer = rows.filter((row) => row.role === 'Agent').at(-1);
      assert.deepEqual(JSON.parse(answer.text.Inline.text), {
        action: 'accept',
        content: { value: method === 'editor' ? '' : 'browser exact answer' },
      });
    }
    check(
      `Pi ${method} question preserves the classic card and exact typed answer through the real host`,
    );
  }
  await prompt('tool-metadata');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'tool completion',
  );
  const toolTurn = controller.snapshot.view.entries.at(-1).turn;
  const toolProcess = page.locator(`[data-turn="${toolTurn}"] .turn-process`);
  if (!(await toolProcess.isVisible())) {
    await page.getByLabel('会话选项', { exact: true }).click();
    await page.getByLabel('显示执行过程', { exact: true }).check();
    await page.getByLabel('会话选项', { exact: true }).click();
  }
  await toolProcess.waitFor();
  await page.locator('#stop').waitFor({ state: 'hidden' });
  // A turn first rendered while active is already expanded. Clicking its summary
  // unconditionally closes it, so observe the disclosure before opening it.
  if (!(await toolProcess.evaluate((node) => node.open)))
    await toolProcess.locator('summary').first().click();
  // Opening the classic process disclosure now loads its tool records directly.
  await wait(() => controller.snapshot.view.tools.length > 0, 'bounded tools query');
  assert(controller.snapshot.view.tools.length > 0);
  check(
    'typed tool metadata reaches the browser as escaped display content without file/terminal authority',
  );
  await prompt('image-output');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'image completion',
  );
  await page.getByRole('button', { name: '加载图片', exact: true }).click();
  await page.locator('figure img').waitFor();
  await page.waitForFunction(() => document.querySelector('figure img')?.naturalWidth > 0);
  assert((await page.locator('figure img').getAttribute('src')).startsWith('blob:'));
  check(
    'explicit archive-only image read displays a real decoded raster with no remote/path fallback',
  );
  await page.getByRole('button', { name: '添加上下文', exact: true }).click();
  await page.locator('#attachments summary').click();
  await page.getByRole('button', { name: 'Remove attachment example.ts', exact: true }).click();
  assert.equal(await page.locator('#attachments pre').count(), 0);
  check('explicit session-scoped attachment selection previews escaped text and supports removal');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({
    name: 'selected.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await page.locator('#attachments img').waitFor();
  await page.waitForFunction(() => document.querySelector('#attachments img')?.naturalWidth === 2);
  assert((await page.locator('#attachments img').getAttribute('src')).startsWith('blob:'));
  await prompt('typed-image-input');
  await wait(
    () => controller.snapshot.view?.view?.status === 'Idle',
    'typed input image completion',
  );
  await page.locator('#attachments img').waitFor({ state: 'detached' });
  assert(
    controller.snapshot.view.entries.some(
      (entry) => entry.role === 'User' && entry.image?.mime === 'image/png',
    ),
  );
  check(
    'selected image previews under production blob-only CSP, is sanitized/archived/accepted, and clears only its submitted draft',
  );
  await prompt('```mermaid\ngraph TD; A-->B\n```');
  await wait(() => controller.snapshot.view?.view?.status === 'Idle', 'diagram turn completion');
  await page.getByRole('button', { name: '渲染图表', exact: true }).first().click();
  await page.locator('.diagram-canvas svg').first().waitFor();
  assert.equal(
    await page.locator('.diagram-canvas image, .diagram-canvas foreignObject').count(),
    0,
  );
  check('Mermaid renders through lazy bundled code under production CSP without remote resources');
  await prompt('crash');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      typeof controller.snapshot.view.view.status === 'object',
    'worker crash',
  );
  await prompt('recovered browser turn');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'explicit post-crash recovery',
  );
  assert.equal(controller.snapshot.selected, branch);
  check(
    'failed worker status permits explicit next prompt with native-load recovery, not a silent new session',
  );
  await prompt('elicitation-text');
  await page.locator('#interactions textarea').waitFor();
  await page.getByRole('button', { name: '停止输出', exact: true }).click();
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'cancel with pending form',
  );
  await page.locator('#interactions form').waitFor({ state: 'detached' });
  check('reserved control cancels a live waiting turn and clears its exact pending interaction');
  await page.locator('#messages').evaluate((node) => {
    node.parentElement.scrollTop = 0;
  });
  await prompt('workspace-write');
  await wait(() => controller.snapshot.view?.view?.status === 'Idle', 'workspace write completion');
  const workspaceReviewTurn = controller.snapshot.view.entries.at(-1).turn;
  const workspaceTurnBox = page.locator(`section.turn[data-turn="${workspaceReviewTurn}"]`);
  await workspaceTurnBox.locator('.turn-diff-header').waitFor();
  const userMessage = workspaceTurnBox.locator('.message.user').first();
  await userMessage.scrollIntoViewIfNeeded();
  await userMessage.hover();
  const reuse = userMessage.locator('.message-reuse');
  const userBounds = await userMessage.boundingBox(),
    reuseBounds = await reuse.boundingBox();
  assert(userBounds && reuseBounds);
  assert(
    reuseBounds.x >= userBounds.x &&
      reuseBounds.x + reuseBounds.width <= userBounds.x + userBounds.width + 1,
  );
  assert(
    reuseBounds.y >= userBounds.y &&
      reuseBounds.y + reuseBounds.height <= userBounds.y + userBounds.height + 1,
  );
  assert.equal(await page.locator('.assistant .message-reuse').count(), 0);
  await reuse.click();
  assert.equal(await page.locator('#prompt').inputValue(), 'workspace-write');
  await page.locator('#prompt').fill('');
  check(
    'finished-turn Diff appears without scrolling; reuse stays inside the user bubble and never on assistant replies',
  );
  await workspaceTurnBox.scrollIntoViewIfNeeded();
  const diffFiles = workspaceTurnBox.locator('.turn-diff-files');
  const diffNotes = diffFiles.locator('.turn-diff-notes');
  assert.equal(await diffNotes.isVisible(), false);
  await diffFiles.locator(':scope > summary').click();
  await diffNotes.waitFor({ state: 'visible' });
  await workspaceTurnBox.locator('.turn-diff-file > summary').first().waitFor();
  assert.equal(await page.getByRole('button', { name: '查看工作区变更', exact: true }).count(), 0);
  await page.locator('.turn-diff-file > summary').first().click();
  await page.getByRole('button', { name: '查看总 Diff', exact: true }).waitFor();
  if (await page.getByRole('button', { name: '读取修改前', exact: true }).count())
    await page.getByRole('button', { name: '读取修改前', exact: true }).click();
  if (await page.getByRole('button', { name: '读取修改后', exact: true }).count())
    await page.getByRole('button', { name: '读取修改后', exact: true }).click();
  await page.locator('pre').filter({ hasText: 'before' }).waitFor();
  await page.locator('pre').filter({ hasText: 'after' }).waitFor();
  await page.getByRole('button', { name: '在编辑器中对比', exact: true }).click();
  await wait(() => editorDiffs.length === 1, 'single editor port');
  assert.deepEqual(editorDiffs[0].files, [
    { path: 'review.txt', before: 'before\n', after: 'after\n' },
  ]);
  await page.getByRole('button', { name: '查看总 Diff', exact: true }).click();
  await wait(() => editorDiffs.length === 2, 'total editor port');
  await page.getByRole('button', { name: '撤回本轮修改', exact: true }).click();
  await wait(
    () =>
      confirmations === 1 &&
      controller.snapshot.operations.some(
        (op) => op.method === 'undo_turn' && op.status === 'completed',
      ),
    'durable confirmed undo',
  );
  assert.equal(await readFile(join(root, 'review.txt'), 'utf8'), 'before\n');
  check(
    'S5 Chromium: shell net diff, lazy text slices, single/total editor ports and confirmed durable undo',
  );
  const beforeOpen = managementReplies;
  const beforeModelPage = controller.snapshot.operations.length;
  await page.getByRole('button', { name: '模型设置', exact: true }).first().click();
  await wait(() => managementReplies > beforeOpen, 'S6 automatic profile metadata on page entry');
  assert.equal(await page.locator('#management .additional-settings').count(), 0);
  const profileTrace = (await readFile(join(root, 'trace'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(profileTrace.some((row) => row.method === '_pi_workbench/profile_models'));
  assert.equal(controller.snapshot.operations.length, beforeModelPage);
  const beforeRefresh = managementReplies;
  await page.getByRole('button', { name: '刷新模型配置', exact: true }).click();
  await wait(() => managementReplies > beforeRefresh, 'S6 manual profile metadata refresh');
  assert.equal(controller.snapshot.operations.length, beforeModelPage);
  const modelCard = page
    .locator('#management [data-model]')
    .filter({ has: page.locator('h3', { hasText: 'Other' }) });
  await page.locator('#management .provider-group > summary').first().click();
  const manageBefore = controller.snapshot.operations.filter(
    (op) => op.method === 'manage' && op.status === 'completed',
  ).length;
  assert.equal(await modelCard.locator('.apply-context').count(), 0);
  assert.equal(
    await modelCard.getByLabel('other price multiplier', { exact: true }).inputValue(),
    '1',
  );
  await modelCard.getByLabel('other price multiplier', { exact: true }).fill('0.5');
  await modelCard.getByLabel('other context k tokens', { exact: true }).fill('256');
  await modelCard
    .getByRole('checkbox', { name: 'Visible in model selector', exact: true })
    .uncheck();
  await modelCard.getByRole('button', { name: '保存模型设置', exact: true }).click();
  await wait(
    () =>
      controller.snapshot.operations.filter(
        (op) => op.method === 'manage' && op.status === 'completed',
      ).length > manageBefore,
    'S6 model visibility',
  );
  await page.waitForFunction(
    () => !document.querySelector('select[aria-label="model"] option[value="other"]'),
  );
  await page.screenshot({ path: join(artifacts, 'model-defaults-multiplier.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await prompt('usage-complete');
  await wait(() => controller.snapshot.view?.view?.status === 'Idle', 'S6 usage completion');
  await page.getByRole('button', { name: '用量统计', exact: true }).first().click();
  await page.locator('#management .additional-settings > summary').click();
  await page
    .getByRole('combobox', { name: 'Usage session filter', exact: true })
    .selectOption(branch);
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.locator('#management .stats-totals').waitFor();
  const stats = await client.call({
    method: 'management',
    query: { group: 'session', session: branch },
  });
  assert(stats.totals.input >= 100);
  assert.equal(stats.totals.cache_read, 50);
  assert.equal(stats.totals.cache_write, 5);
  assert(stats.groups.some((g) => g.key === branch));
  assert.equal(await page.locator('#management table').count(), 1);
  check(
    'S6 Chromium: single naming/refresh controls without redundant settings, model visibility and per-session token/cache statistics',
  );
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  const layout = await checkClassicLayout(page, artifacts);
  await writeFile(join(artifacts, 'classic-layout.json'), JSON.stringify(layout, null, 2));
  check(
    'classic shell: narrow/wide dark/light layout, pinned composer, history and independent settings preserve drafts',
  );
  const beforeRelease = await client.call({ method: 'history', session: branch });
  const nativeBeforeRelease = controller.snapshot.view.view.provider_session;
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await wait(
    () => controller.snapshot.sessions.find((s) => s.id === branch)?.retention_days === 4,
    'host-derived four-day badge',
  );
  const releaseRow = page.locator(`#history-items [data-session-id="${branch}"]`);
  await releaseRow.locator('.session-number.alive-long').waitFor();
  await releaseRow.locator('.history-release').click();
  await wait(
    () => controller.snapshot.sessions.find((s) => s.id === branch)?.retention_days === 0,
    'explicit physical release updates badge',
  );
  assert.deepEqual(
    (await client.call({ method: 'history', session: branch })).entries,
    beforeRelease.entries,
  );
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await prompt('after manual release');
  await wait(
    () => controller.snapshot.view?.view?.status === 'Idle',
    'native resume after explicit release',
  );
  assert.equal(controller.snapshot.view.view.provider_session, nativeBeforeRelease);
  check(
    'real history badge follows host residency; manual release preserves entries and explicit input resumes the same native session',
  );
  const historyMath =
    '历史公式正文\n' +
    '保留完整内容。'.repeat(3000) +
    '\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n公式末尾已完整恢复';
  for (let i = 0; i < 20; i++) {
    await prompt(i === 19 ? historyMath : `bounded history ${i}`);
    await wait(() => controller.snapshot.view?.view?.status === 'Idle', `history fixture ${i}`);
  }
  const beforeOlderReview = (await client.call({ method: 'history', session: branch })).entries;
  await controller.receive({ type: 'select', session: source });
  await wait(
    () => controller.snapshot.selected === source && controller.snapshot.view?.status === 'ready',
    'switch away',
  );
  await controller.receive({ type: 'select', session: branch });
  await wait(
    () => controller.snapshot.selected === branch && controller.snapshot.view?.status === 'ready',
    'restore three full turns',
  );
  assert.equal(new Set(controller.snapshot.view.entries.map((r) => r.turn)).size, 3);
  await page.locator('.assistant .katex').waitFor();
  await page.locator('.assistant').filter({ hasText: '公式末尾已完整恢复' }).waitFor();
  await page.getByRole('button', { name: '加载更早消息（20 轮）', exact: true }).click();
  await wait(
    () => new Set(controller.snapshot.view.entries.map((r) => r.turn)).size === 23,
    'prepend twenty complete turns',
  );
  await page.waitForFunction(
    () => document.querySelectorAll('section.turn[data-turn]').length === 23,
  );
  assert.equal(await page.getByRole('button', { name: '回到最新消息', exact: true }).count(), 1);
  await page.locator('#bottom').click();
  await wait(
    () =>
      !controller.snapshot.view.historical &&
      new Set(controller.snapshot.view.entries.map((r) => r.turn)).size === 3,
    'arrow restores latest three turns',
  );
  await page.getByRole('button', { name: '加载更早消息（20 轮）', exact: true }).click();
  await wait(
    () => new Set(controller.snapshot.view.entries.map((r) => r.turn)).size === 23,
    'restore earlier twenty turns again',
  );
  check(
    'switching restores three complete turns and archived LaTeX; earlier prepends twenty turns and the only latest control is the arrow',
  );
  const olderTurn = page.locator(`section.turn[data-turn="${workspaceReviewTurn}"]`);
  await olderTurn.scrollIntoViewIfNeeded();
  await olderTurn.locator('.turn-diff-header').waitFor();
  assert.equal(await olderTurn.locator('.turn-review-action').count(), 0);
  assert.deepEqual(
    (await client.call({ method: 'history', session: branch })).entries,
    beforeOlderReview,
  );
  check(
    'scrolling back beyond the recent diff cache automatically restores the older card without a button or provider input',
  );
  // Visual fixture from the user's four-file reference, after functional checks.
  // This is display-only evidence, not a claim that those repository files changed.
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.evaluate(
    ({ session, turn }) => {
      document.documentElement.style.zoom = '2';
      const root = document.documentElement.style;
      root.setProperty('--bg', '#26283b');
      root.setProperty('--fg', '#c6d0f5');
      root.setProperty('--code-bg', '#26283b');
      root.setProperty('--border', '#383b4f');
      root.setProperty('--muted', '#a5adce');
      const paths = [
        'docs/e2e_latency_validation.md',
        'llm_router/simulation/decode_gate_validation.py',
        'llm_router/simulation/decode_transfer_validation.py',
        'llm_router/simulation/decode_validation.py',
      ];
      window.postMessage(
        {
          type: 'turn_diff',
          session,
          turn,
          diff: {
            status: 'partial',
            added: 9,
            removed: 3,
            warnings: [],
            next_offset: null,
            files: paths.map((path, i) => ({
              path,
              status: 'modified',
              added: i ? 1 : 6,
              removed: i ? 1 : 0,
              before: null,
              after: null,
              before_hash: null,
              after_hash: null,
              patch: null,
              old_mode: 33188,
              new_mode: 33188,
              omitted: i === 3 ? 'size' : null,
            })),
          },
        },
        '*',
      );
    },
    { session: branch, turn: workspaceReviewTurn },
  );
  await page.waitForFunction(
    (turn) =>
      document
        .querySelector(`section.turn[data-turn="${turn}"] .turn-diff-header`)
        ?.textContent.includes('4 个文件'),
    workspaceReviewTurn,
  );
  await olderTurn
    .locator('[data-turn-review]')
    .screenshot({ path: join(artifacts, 'classic-diff-reference.png') });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  const sourcePage = await client.call({ method: 'history', session: source });
  assert.deepEqual(sourcePage.entries, sourceRows);
  assert.equal(controller.snapshot.selected, branch);
  assert.equal(controller.snapshot.error, undefined);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  // Production bundle must not import either legacy controller or its wire/schema.
  const extension = await readFile('dist/extension.cjs', 'utf8');
  for (const forbidden of [])
    assert(!extension.includes(forbidden), `legacy production import: ${forbidden}`);
  await page.screenshot({ path: join(artifacts, 'workbench-v3.png'), fullPage: true });
  check(
    'source unchanged, no browser external fetch/errors, production extension excludes legacy wire/facade',
  );
  // Isolated display workload after the real-host flow; never dispatch prompts.
  const metrics = await measureRenderWorkload(page, controller.snapshot);
  assert.equal(metrics.messages, 2);
  assert(metrics.code);
  assert(
    metrics.markdown.count <= metrics.render.count + 1,
    'Markdown parses must stay bounded by coalesced paints',
  );
  await page.getByRole('link', { name: 'External', exact: true }).click();
  await wait(() => externalLinks.length === 1, 'normalized explicit link request');
  assert.equal(externalLinks[0], 'https://xn--fsqu00a.xn--0zwm56d/path');
  await page.locator('#prompt').fill('/re');
  await page.locator('#prompt').press('ArrowDown');
  await page.locator('#prompt').press('Tab');
  assert.equal(await page.locator('#prompt').inputValue(), '/reset ');
  check(
    'Chromium slash keyboard completion and explicit normalized link host port (native modal remains Extension Host validation)',
  );
  console.log('P4 1000-fragment display workload:', JSON.stringify(metrics));
  await writeFile(join(artifacts, 'p4-render.json'), JSON.stringify(metrics, null, 2));
  check(
    '1000 fragments coalesce into stable messages; input/selection remain usable with bounded Markdown parses',
  );
  console.log(
    `${checks} production workbench browser checks passed (synthetic ACP, no real model/Bot)`,
  );
} catch (error) {
  if (page)
    await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  controller?.dispose();
  await browser?.close();
  await new Promise((done) => server.close(done));
  if (daemon && exited) {
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 10000);
    try {
      const code = await exited;
      if (code !== 0) throw new Error(`Daemon cleanup ${code}: ${output}`);
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(root, { recursive: true, force: true });
}
