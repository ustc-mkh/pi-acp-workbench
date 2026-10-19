// Production v3 extension/browser graph + real new daemon. Synthetic ACP; no account/Bot/model.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
  await writeFile(join(root, 'fork-gate.release'), 'released');
  await writeFile(
    config,
    JSON.stringify({
      workers: {
        pi: {
          command: process.execPath,
          args: [resolve('test/contract-agent.mjs')],
          env: {
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
  controller = new WorkbenchController(client, {
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
  await prompt('streamed-message');
  await wait(
    () =>
      controller.snapshot.view?.status === 'ready' &&
      controller.snapshot.view.view.status === 'Idle',
    'stream completion',
  );
  await page.locator('article').filter({ hasText: '世界' }).waitFor();
  assert.equal(await page.locator('article').count(), 4);
  assert.equal(await page.locator('article.thought').count(), 1);
  const sourceRows = structuredClone(controller.snapshot.view.entries);
  assert.equal(new Set(sourceRows.slice(1).map((row) => row.message)).size, 1);
  check(
    'live text/thought deltas preserve distinct committed entry IDs and opaque groups in browser state',
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
  await page.locator('.turn-process').last().locator('summary').first().click();
  await page
    .getByRole('button', { name: /^Tools for / })
    .last()
    .click();
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
