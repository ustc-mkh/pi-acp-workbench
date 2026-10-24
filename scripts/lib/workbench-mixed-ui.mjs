// Headless production bundle connected to the same isolated mixed-load host.
// Display deltas are injected; no synthetic provider output is passed as real.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { measureRenderWorkload } from './workbench-render-workload.mjs';

export async function startMixedUI(socket, workspace, session) {
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
  const errors = [];
  let browser, controller, page;
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const file = resolve('dist', '.' + request.url);
      assert(file.startsWith(resolve('dist') + '/'));
      const body = await readFile(file);
      response.setHeader(
        'Content-Type',
        { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] ||
          'application/octet-stream',
      );
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  const close = async () => {
    controller?.dispose();
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const executablePath =
      process.env.CHROME_PATH ||
      (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : chromium.executablePath());
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox'],
      // The runner owns interruption, evidence persistence and host join.
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    page = await browser.newPage({ viewport: { width: 460, height: 940 }, colorScheme: 'dark' });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:'))
        errors.push(`unexpected browser request: ${request.url()}`);
    });
    const client = new WorkbenchClient(socket);
    controller = new WorkbenchController(client, {
      post: (message) => {
        void page
          .evaluate((value) => window.postMessage(value, '*'), message)
          .catch((error) => errors.push(String(error)));
      },
      trusted: () => true,
      workspace: () => workspace,
      authorize: async (cwd) => assert.equal(cwd, workspace),
    });
    await page.exposeFunction('workbenchReceive', (message) => controller.receive(message));
    await page.goto(origin + '/style.css');
    await page.setContent(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-mixed' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src blob:; connect-src 'none';"><link rel="stylesheet" href="${origin}/style.css"><link rel="stylesheet" href="${origin}/katex.min.css"></head><body><main id="workbench"></main></body></html>`,
    );
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => void window.workbenchReceive(message),
      });
    });
    await page.addScriptTag({ url: origin + '/webview.js', type: 'module' });
    await controller.receive({ type: 'select', session });
    const readyDeadline = performance.now() + 15000;
    while (
      controller.snapshot.view?.status !== 'ready' ||
      controller.snapshot.selected !== session
    ) {
      assert(performance.now() < readyDeadline, 'mixed UI attach must finish before sampling');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(controller.snapshot.view?.status, 'ready');
    const displaySnapshot = structuredClone(controller.snapshot);
    return {
      async sample() {
        assert.deepEqual(errors, []);
        const metrics = await measureRenderWorkload(page, displaySnapshot);
        assert.equal(metrics.messages, 2);
        assert(metrics.code);
        assert(metrics.markdown.count <= 16);
        assert.deepEqual(errors, []);
        return metrics;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
