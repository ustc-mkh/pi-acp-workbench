import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
const demoBundle = await build({ entryPoints: ['src/demo.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { demoMarkdown } = await import('data:text/javascript;base64,' + Buffer.from(demoBundle.outputFiles[0].text).toString('base64'));
const channelBundle = await build({ entryPoints: ['src/state-channel.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { StateEncoder } = await import('data:text/javascript;base64,' + Buffer.from(channelBundle.outputFiles[0].text).toString('base64'));
const encoder = new StateEncoder();
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
  // Reproduce the VS Code Webview defaults, including inherited standard
  // scrollbar-color (which overrides WebKit pseudo-elements in Chromium).
  await page.addStyleTag({content:`html { scrollbar-color: #888888 #112233; }
    ::-webkit-scrollbar { width:10px; height:10px; }
    ::-webkit-scrollbar-corner { background-color:#112233; }
    ::-webkit-scrollbar-thumb { background-color:#888888; }`});
  await page.evaluate(() => {
    window.messages = [];
    window.savedState = {};
    window.acquireVsCodeApi = () => ({ postMessage: m => window.messages.push(m), getState: () => window.savedState, setState: state => {window.savedState=state;} });
  });
  await page.addScriptTag({ url: origin + '/webview.js' });
  const state = { status: 'disconnected', entries: [], attachments: [], commands: [], plan: [], history: [], permissions: [], showThoughts: true, preview: false };
  const emit = async s => { await page.evaluate(message => window.postMessage(message, '*'), encoder.encode(s)); await page.waitForTimeout(75); };
  await emit(state);
  const inputHeight = await page.locator('#input').evaluate(node=>node.getBoundingClientRect().height);
  const separator = await page.locator('#composer-resizer').boundingBox();
  await page.mouse.move(separator.x+separator.width/2,separator.y+separator.height/2);
  await page.mouse.down(); await page.mouse.move(separator.x+separator.width/2,separator.y-60,{steps:5}); await page.mouse.up();
  assert((await page.locator('#input').evaluate(node=>node.getBoundingClientRect().height)) > inputHeight+50);
  assert.equal(await page.locator('#input').evaluate(node=>getComputedStyle(node).resize), 'none');
  assert.equal(await page.locator('#input').evaluate(node=>getComputedStyle(node,'::-webkit-scrollbar-button').display), 'none');
  for (const selector of ['html','#transcript','#input','#history-items','#statistics']) {
    assert.equal(await page.locator(selector).evaluate(node=>getComputedStyle(node).scrollbarColor), 'auto');
    assert.equal(await page.locator(selector).evaluate(node=>getComputedStyle(node,'::-webkit-scrollbar').width), '6px');
    assert.equal(await page.locator(selector).evaluate(node=>getComputedStyle(node,'::-webkit-scrollbar-track').backgroundColor), 'rgba(0, 0, 0, 0)');
  }
  assert.equal(await page.locator('#transcript').evaluate(node=>node.offsetWidth-node.clientWidth),6);
  assert((await page.evaluate(()=>window.savedState.composerHeight)) > 100);
  assert(await page.locator('#start-session').isVisible());
  await page.locator('#start-session').click();
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'new'));
  assert(!(await page.evaluate(() => window.messages)).some(m => m.type === 'connect'));
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
  assert.equal(await page.locator('.activity-group').evaluate(node=>node.open), false);
  await page.locator('#toggle-activity').click();
  assert.equal(await page.locator('.activity-group').evaluate(node=>node.open), true);
  await page.locator('.message.tool > summary').click(); await page.getByText('查看修改 · /project/test.ts').click();
  assert((await page.evaluate(() => window.messages)).some(m => m.type === 'diff' && m.index === 0));
  state.history = [{id:'s1',sessionNumber:1,title:'相同标题',cwd:'/project',updated:2},{id:'s2',sessionNumber:2,title:'相同标题',cwd:'/project',updated:1}];
  state.sessionId='s1'; state.sessionNumber=1; state.status='ready'; await emit(state);
  await page.locator('#history-toggle').click();
  assert.deepEqual(await page.locator('#history-items .session-number').allTextContents(),['#001','#002']);
  assert.equal(await page.locator('#session-number').textContent(),'#001');
  await page.locator('#history-toggle').click();
  await page.locator('#input').fill('Pi private draft');
  await page.locator('#harness-switch').selectOption('codex');
  assert((await page.evaluate(()=>window.messages)).some(m=>m.type==='switchHarness'&&m.harness==='codex'));
  state.contextComplete=true;state.harness='codex';state.sessionId='workbench:codex:s1';await emit(state);
  assert.equal(await page.locator('#input').inputValue(),'');
  assert.equal(await page.locator('#harness-switch').inputValue(),'codex');
  assert(await page.locator('#harness-help').isVisible());
  assert(await page.locator('[data-context-action]').first().isDisabled());
  await page.locator('#input').fill('Codex private draft');
  state.harness='pi';state.sessionId='s1';await emit(state);
  assert.equal(await page.locator('#input').inputValue(),'Pi private draft');
  assert(await page.locator('[data-context-action]').first().isEnabled());
  state.harness='codex';state.sessionId='workbench:codex:s1';state.status='busy';await emit(state);
  assert.equal(await page.locator('#input').inputValue(),'Codex private draft');
  assert(await page.locator('#harness-switch').isDisabled());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  state.status='ready';await emit(state);
  const readyBefore = await page.evaluate(() => window.messages.filter(m => m.type === 'ready').length);
  await page.evaluate(() => window.postMessage({type:'statePatch',revision:999,fields:{},unset:[],entries:[]}, '*'));
  await page.waitForTimeout(75);
  assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'ready').length), readyBefore + 1);
  encoder.reset(); await emit(state);
  assert.equal(await page.locator('.message.tool').count(), 1);
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: dark/light math, narrow viewport, incremental state, resynchronization, streamed math, activity folding, separator drag, quiet scrollbars, harness selection/draft isolation, send, permission, cancel, diff, no runtime errors.');
} finally { await browser?.close(); server.close(); }
