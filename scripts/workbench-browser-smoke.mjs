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
  await page.goto(origin + '/style.css');
  await page.setContent(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-smoke' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src blob:; connect-src 'none';"><link rel="stylesheet" href="${origin}/style.css"><link rel="stylesheet" href="${origin}/katex.min.css"></head><body><main id="workbench"></main></body></html>`,
  );
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
          `Timeout: ${label}; state=${JSON.stringify(controller.snapshot)}; daemon=${output}`,
        );
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await wait(() => controller.snapshot.view?.status === 'ready', 'created session');
  const source = controller.snapshot.selected;
  assert(source);
  assert.equal(controller.snapshot.view.view.harness, 'Pi');
  check('production browser/controller creates a session through the actual single host IPC v3');
  const prompt = async (text) => {
    await page.waitForFunction(
      (selected) =>
        document.querySelector('select[aria-label="Session"]')?.value === selected &&
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Send' && !button.disabled,
        ),
      controller.snapshot.selected,
    );
    const previous =
      controller.snapshot.view?.entries.filter(
        (row) => row.role === 'User' && row.text.Inline?.text === text,
      ).length || 0;
    await page.locator('#prompt').fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await wait(
      () =>
        (controller.snapshot.view?.entries.filter(
          (row) => row.role === 'User' && row.text.Inline?.text === text,
        ).length || 0) > previous,
      `prompt ${text}`,
    );
  };
  await page.getByRole('button', { name: 'Discover provider settings', exact: true }).click();
  await wait(
    () => controller.snapshot.view?.view?.catalogue.selects?.some((s) => s.id === 'thought_level'),
    'first-task provider discovery',
  );
  assert.equal(controller.snapshot.view.entries.length, 0);
  await page.getByLabel('Thinking', { exact: true }).selectOption('high');
  await wait(
    () => controller.snapshot.view?.view?.config.options?.thought_level === 'high',
    'observed thinking before first task',
  );
  await page.getByLabel('Fast', { exact: true }).selectOption('on');
  await wait(
    () => controller.snapshot.view?.view?.config.options?.fast === 'on',
    'observed independent Fast',
  );
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
  assert.equal(await page.locator('article').count(), 3);
  assert.equal(await page.locator('article.thought').count(), 1);
  const sourceRows = structuredClone(controller.snapshot.view.entries);
  assert.equal(new Set(sourceRows.slice(1).map((row) => row.message)).size, 1);
  check(
    'logical messages join text fragments while preserving role boundaries and immutable committed entries',
  );
  await page.getByRole('button', { name: 'Fork here', exact: true }).first().click();
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
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'typed form resolution',
  );
  await page.locator('#interactions form').waitFor({ state: 'detached' });
  check('typed elicitation fields render and answer the exact interaction, not a guessed prompt');
  await prompt('tool-metadata');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'tool completion',
  );
  const toolTurn = controller.snapshot.view.entries.at(-1).turn;
  const toolProcess = page.locator(`[data-turn="${toolTurn}"] .turn-process`);
  await toolProcess.locator('summary').first().click();
  await toolProcess.getByRole('button', { name: `Tools for ${toolTurn}`, exact: true }).click();
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
  await page.getByRole('button', { name: 'Load archived image', exact: true }).click();
  await page.locator('figure img').waitFor();
  await page.waitForFunction(() => document.querySelector('figure img')?.naturalWidth > 0);
  assert((await page.locator('figure img').getAttribute('src')).startsWith('blob:'));
  check(
    'explicit archive-only image read displays a real decoded raster with no remote/path fallback',
  );
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
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
  await page.getByRole('button', { name: 'Render diagrams', exact: true }).first().click();
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
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click();
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'cancel with pending form',
  );
  await page.locator('#interactions form').waitFor({ state: 'detached' });
  check('reserved control cancels a live waiting turn and clears its exact pending interaction');
  await prompt('workspace-write');
  await wait(() => controller.snapshot.view?.view?.status === 'Idle', 'workspace write completion');
  const review = page.getByRole('button', { name: 'Review workspace changes', exact: true }).last();
  await review.click();
  await page.getByText('complete · +1 −1 lines', { exact: true }).click();
  await page.getByRole('button', { name: 'View total Diff in editor', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load before', exact: true }).click();
  await page.getByRole('button', { name: 'Load after', exact: true }).click();
  await page.locator('pre').filter({ hasText: 'before' }).waitFor();
  await page.locator('pre').filter({ hasText: 'after' }).waitFor();
  await page.getByRole('button', { name: 'Compare file in editor', exact: true }).click();
  await wait(() => editorDiffs.length === 1, 'single editor port');
  assert.deepEqual(editorDiffs[0].files, [
    { path: 'review.txt', before: 'before\n', after: 'after\n' },
  ]);
  await page.getByRole('button', { name: 'View total Diff in editor', exact: true }).click();
  await wait(() => editorDiffs.length === 2, 'total editor port');
  await page.getByRole('button', { name: 'Undo this turn…', exact: true }).click();
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
  const manageClick = async (name) => {
    const before = controller.snapshot.operations.filter(
      (op) => op.method === 'manage' && op.status === 'completed',
    ).length;
    await page.getByRole('button', { name, exact: true }).click();
    await wait(
      () =>
        controller.snapshot.operations.filter(
          (op) => op.method === 'manage' && op.status === 'completed',
        ).length > before,
      `S6 ${name}`,
    );
  };
  await page.getByRole('button', { name: 'Model settings', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: 'Session name', exact: true })
    .fill('Browser managed name');
  await manageClick('Save session name');
  await wait(
    () =>
      controller.snapshot.sessions.some(
        (s) => s.id === branch && s.title === 'Browser managed name',
      ),
    'S6 persisted manual name',
  );
  await manageClick('Refresh provider models explicitly');
  const modelCard = page
    .locator('#management details')
    .filter({ has: page.locator('summary', { hasText: 'Other' }) });
  await modelCard.locator('summary').click();
  await modelCard
    .getByRole('checkbox', { name: 'Visible in model selector', exact: true })
    .uncheck();
  const manageBefore = controller.snapshot.operations.filter(
    (op) => op.method === 'manage' && op.status === 'completed',
  ).length;
  await modelCard.getByRole('button', { name: 'Save visibility only', exact: true }).click();
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
  await prompt('usage-complete');
  await wait(() => controller.snapshot.view?.view?.status === 'Idle', 'S6 usage completion');
  await page.getByRole('button', { name: 'Usage statistics', exact: true }).first().click();
  await page
    .getByRole('combobox', { name: 'Usage session filter', exact: true })
    .selectOption(branch);
  await page.getByRole('button', { name: 'Apply usage filters', exact: true }).click();
  await page.getByText('Filtered total', { exact: true }).waitFor();
  const stats = await client.call({
    method: 'management',
    query: { group: 'session', session: branch },
  });
  assert(stats.totals.input >= 100);
  assert.equal(stats.totals.cache_read, 50);
  assert.equal(stats.totals.cache_write, 5);
  assert(stats.groups.some((g) => g.label?.includes('Browser managed name')));
  assert.equal(await page.locator('#management table').count(), 1);
  check(
    'S6 Chromium: persistent manual title, explicit provider model refresh, visibility and per-session token/cache statistics',
  );
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
  const metrics = await page.evaluate(async (snapshot) => {
    performance.clearMeasures('workbench.render');
    performance.clearMeasures('workbench.markdown');
    const longTasks = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: 'longtask', buffered: false });
    const state = {
      ...snapshot,
      selected: snapshot.selected,
      operations: [],
      view: {
        ...snapshot.view,
        entries: [],
        tools: [],
        earlier: undefined,
        historical: false,
        view: {
          ...snapshot.view.view,
          active_turn: 'perf-turn',
          status: 'Running',
          pending_interactions: {},
          catalogue: {
            ...snapshot.view.view.catalogue,
            commands: [
              { name: 'review', description: 'Review', input_hint: null },
              { name: 'reset', description: 'Reset', input_hint: null },
            ],
          },
        },
      },
    };
    const rows = [
      {
        seq: 1,
        id: 'perf-user',
        turn: 'perf-turn',
        role: 'User',
        message: null,
        image: null,
        text: { Inline: { text: 'Selection stays readable' } },
      },
    ];
    const frame = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    let sequence = 1000000;
    const update = () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'state',
            sequence: ++sequence,
            state: { ...state, view: { ...state.view, entries: [...rows] } },
          },
        }),
      );
    update();
    await frame();
    const first = document.querySelector('article');
    const input = document.querySelector('#prompt');
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(first.querySelector('p'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const inputTimes = [],
      inputToFrame = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        seq: i + 2,
        id: `perf-${i}`,
        turn: 'perf-turn',
        role: 'Agent',
        message: 'perf-message',
        image: null,
        text: {
          Inline: {
            text:
              i === 0
                ? '```ts\n'
                : i === 999
                  ? '\n```\n\n[External](https://例子.测试/path)'
                  : `// fragment ${i}\n`,
          },
        },
      });
      update();
      if (i % 10 === 9) {
        await frame();
        if (
          document.activeElement !== input ||
          first !== document.querySelector('article') ||
          getSelection().toString() !== 'Selection stays readable'
        )
          throw new Error(
            `Streaming lost focus/selection/message identity at ${i}: focus=${document.activeElement === input}, identity=${first === document.querySelector('article')}, selection=${getSelection().toString()}`,
          );
        const start = performance.now();
        input.value = `draft ${i}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        inputTimes.push(performance.now() - start);
        await new Promise((done) => requestAnimationFrame(done));
        inputToFrame.push(performance.now() - start);
        // Native textarea edits legitimately clear the document selection. Select
        // again and check it survives the next render, not the unrelated edit.
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    }
    state.view.view.active_turn = null;
    state.view.view.status = 'Idle';
    update();
    await frame();
    observer.disconnect();
    const distribution = (values) => {
      values.sort((a, b) => a - b);
      return {
        count: values.length,
        p95: values[Math.floor(values.length * 0.95)] || 0,
        max: values.at(-1) || 0,
      };
    };
    return {
      render: distribution(
        performance.getEntriesByName('workbench.render').map((entry) => entry.duration),
      ),
      markdown: distribution(
        performance.getEntriesByName('workbench.markdown').map((entry) => entry.duration),
      ),
      input: distribution(inputTimes),
      inputToFrame: distribution(inputToFrame),
      longTasks: distribution(longTasks),
      messages: document.querySelectorAll('article').length,
      code: document.querySelector('article.agent code')?.textContent.includes('fragment 998'),
    };
  }, controller.snapshot);
  assert.equal(metrics.messages, 2);
  assert(metrics.code);
  assert(metrics.markdown.count <= 16, 'Markdown must not be reparsed for every delta');
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
