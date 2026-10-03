import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const demoBundle = await build({ entryPoints: ['src/demo.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { demoMarkdown } = await import('data:text/javascript;base64,' + Buffer.from(demoBundle.outputFiles[0].text).toString('base64'));
const server = createServer(async (req, res) => {
  try {
    const file = resolve('dist', '.' + req.url);
    if (!file.startsWith(resolve('dist') + '/')) throw new Error('Path');
    const body = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] || 'application/octet-stream'); res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 460, height: 940 }, colorScheme: 'dark' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin + '/style.css');
  await page.setContent(`<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="${origin}/katex.min.css"><link rel="stylesheet" href="${origin}/style.css"></head><body><div id="app"></div></body></html>`);
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({ postMessage: m => window.messages.push(m), getState: () => ({}), setState: () => {} });
  });
  await page.addScriptTag({ url: origin + '/webview.js' });
  const state = { status: 'disconnected', entries: [], attachments: [], commands: [], plan: [], history: [], permissions: [], showThoughts: true, preview: false };
  const emit = async s => { await page.evaluate(state => window.postMessage({ type: 'state', state }, '*'), s); await page.waitForTimeout(75); };
  await emit(state);
  await page.getByText('预览 Markdown 与公式').click();
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'preview'));
  state.preview = true; state.entries = [{ id: 'demo', role: 'assistant', text: demoMarkdown }];
  await emit(state);
  await page.evaluate(() => document.fonts.ready);
  assert(await page.locator('.katex').count() >= 7);
  assert.equal(await page.locator('.math-fallback').count(), 0);
  await page.evaluate(() => { document.querySelector('#transcript').scrollTop = 0; });
  await page.screenshot({ path: '../preview-dark.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  await emit(state);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addStyleTag({ content: ':root{--bg:#fafafa;--fg:#242424;--muted:#666;--border:#ddd;--input:#f0f0f0;--vscode-textCodeBlock-background:#f3f3f3}' });
  await page.evaluate(() => { document.querySelector('#transcript').scrollTop = 0; });
  await page.screenshot({ path: '../preview-light.png' });
  state.preview = false; state.status = 'ready';
  await emit(state);
  await page.locator('#input').fill('推导这个公式'); await page.locator('#input').press('Enter');
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'send' && m.text === '推导这个公式'));
  await page.evaluate(() => window.postMessage({ type: 'sent' }, '*')); await page.waitForTimeout(40); assert.equal(await page.locator('#input').inputValue(), '');
  state.status = 'busy'; state.entries = [{ id: 'stream', role: 'assistant', text: '$$\\frac{1}' }]; await emit(state);
  state.entries[0].text += '{2}$$'; await emit(state); assert.equal(await page.locator('.katex').count(), 1);
  state.permissions = [{ id: 'p1', request: { sessionId: 's', toolCall: { title: 'Edit test.ts', toolCallId: 't1' }, options: [{ optionId: 'deny-1', name: '拒绝本次', kind: 'reject_once' }] } }]; await emit(state);
  await page.getByText('拒绝本次', { exact: true }).click();
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'permission' && m.optionId === 'deny-1'));
  await page.locator('#stop').click(); assert((await page.evaluate(() => window.messages)).some(m => m.type === 'cancel'));
  state.permissions = []; state.entries = [{ id: 'tool', role: 'tool', tool: { toolCallId: 'edit', title: 'Edit file', status: 'completed', content: [{ type: 'diff', path: '/project/test.ts', oldText: 'a', newText: 'b' }] } }]; await emit(state);
  await page.locator('summary').first().click(); await page.getByText('查看修改 · /project/test.ts').click();
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'diff' && m.index === 0));
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: dark/light math, narrow viewport, streamed math, send, permission, cancel, diff, no runtime errors.');
} finally { await browser?.close(); server.close(); }
