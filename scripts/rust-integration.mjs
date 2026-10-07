// Both REAL Rust daemons; only Telegram HTTP and the ACP worker are mocked.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { ContractWire } from './lib/contract-wire.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`integration timeout: ${label}`);
}
const root = await mkdtemp(join(tmpdir(), 'pi-rust-integration-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
execFileSync('git', ['init', '-q', workspace]);
const chat = -1009999,
  user = 42,
  token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let updateId = 0,
  messageId = 0,
  topicId = 700,
  updates = [],
  sent = [];
const message = (text, thread) =>
  updates.push({
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      chat: { id: chat, type: 'supergroup' },
      from: { id: user },
      text,
      ...(thread ? { message_thread_id: thread } : {}),
    },
  });
const callback = (data, thread) =>
  updates.push({
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: user },
      data,
      message: {
        message_id: 88,
        chat: { id: chat, type: 'supergroup' },
        message_thread_id: thread,
      },
    },
  });
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    const method = req.url.slice(1),
      params = JSON.parse(body || '{}');
    const reply = (result) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') return reply({ id: 123, username: 'integration_bot' });
    if (method === 'getWebhookInfo') return reply({ url: '' });
    if (method === 'getChat') return reply({ id: chat, type: 'supergroup', is_forum: true });
    if (method === 'getUpdates') {
      if (!updates.length) await delay(100);
      const batch = updates.filter((update) => update.update_id >= (params.offset || 0));
      updates = updates.filter((update) => update.update_id < (params.offset || 0));
      return reply(batch);
    }
    sent.push({ method, params });
    if (method === 'createForumTopic') return reply({ message_thread_id: ++topicId });
    if (method === 'sendMessage' || method === 'editMessageText')
      return reply({ message_id: ++messageId });
    return reply(true);
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const sessionsConfig = join(root, 'sessions.json'),
  telegramConfig = join(root, 'telegram.json');
await writeFile(
  sessionsConfig,
  JSON.stringify({
    command: process.execPath,
    args: [resolve('test/contract-agent.mjs')],
    maxWorkers: 2,
    idleMs: 60000,
  }),
);
await writeFile(
  telegramConfig,
  JSON.stringify({
    chatId: chat,
    allowedUserIds: [user],
    workspaces: { main: workspace },
    restrictToWorkspaces: true,
  }),
);
const children = [];
async function start(binary, config, env = {}) {
  const child = spawn(resolve(binary), ['--config', config, '--data-dir', root], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '',
    errors = '';
  child.stderr.on('data', (data) => (errors = (errors + data).slice(-8000)));
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off('error', failed);
      child.off('exit', closed);
      child.stdout.off('data', ready);
      error ? reject(error) : resolve();
    };
    const failed = (error) => finish(error),
      closed = (code) => finish(new Error(`daemon exited ${code}: ${errors}`));
    const ready = (data) => {
      output += data;
      if (output.includes('ready')) finish();
    };
    const timer = setTimeout(() => finish(new Error(`startup timeout: ${errors}`)), 15000);
    child.once('error', failed);
    child.once('exit', closed);
    child.stdout.on('data', ready);
  });
  return child;
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
const relayEnv = {
  PI_TELEGRAM_BOT_TOKEN: token,
  PI_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}`,
  PI_TELEGRAM_PACE_MS: '1',
};
const bindingFile = join(root, 'telegram', `bot-123-chat-${chat}.json`);
const sentText = (text) =>
  sent.some((item) => item.method === 'sendMessage' && item.params.text?.includes(text));
let client;
try {
  await start('rust/target/debug/pi-acp-session-daemon', sessionsConfig);
  let relay = await start(
    'rust/target/contract/debug/pi-acp-telegram-daemon',
    telegramConfig,
    relayEnv,
  );
  client = await ContractWire.open(join(root, 'service', 'sessions.sock'));
  message('/new main');
  const binding = await until(async () => {
    try {
      return JSON.parse(await readFile(bindingFile, 'utf8')).topics[0];
    } catch {
      return undefined;
    }
  }, 'new topic binding');
  const id = binding.sessionId,
    thread = binding.threadId;
  assert.equal((await client.call('state', { sessionId: id })).snapshot.cwd, workspace);
  console.log('ok   Telegram /new creates a real Rust service session');
  await client.call('_watch', { sessionId: id, enabled: true });
  message('phone integration', thread);
  await until(() => sentText('echo: phone integration'), 'phone completion delivery');
  const snapshot = (await client.call('state', { sessionId: id })).snapshot;
  assert(snapshot.entries.some((entry) => entry.text === 'phone integration'));
  assert(snapshot.entries.some((entry) => entry.text === 'echo: phone integration'));
  assert(client.events.some((event) => event.type === 'state' || event.type === 'update'));
  console.log('ok   phone prompt, desktop subscription and outbox completion share the same task');

  message('permission', thread);
  const card = await until(
    () =>
      sent.find((item) =>
        item.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('p:'),
      ),
    'permission card',
  );
  callback(card.params.reply_markup.inline_keyboard[0][0].callback_data, thread);
  await until(
    () =>
      sentText('已提交') ||
      sent.some((item) => item.method === 'answerCallbackQuery' && item.params.text === '已提交'),
    'permission response',
  );
  await until(
    async () => !(await client.call('state', { sessionId: id })).busy,
    'permission turn finish',
  );
  console.log('ok   Telegram permission callback reaches the real Rust worker');

  message('wait', thread);
  await until(async () => (await client.call('state', { sessionId: id })).busy, 'held phone task');
  message('/stop', thread);
  await until(
    async () => !(await client.call('state', { sessionId: id })).busy,
    'cancelled phone task',
  );
  console.log('ok   Telegram /stop cancels the real Rust task');

  await stop(relay);
  const before = JSON.parse(await readFile(bindingFile, 'utf8'));
  await client.call('prompt', {
    sessionId: id,
    prompt: [{ type: 'text', text: 'desktop while relay offline' }],
    source: 'desktop',
  });
  relay = await start(
    'rust/target/contract/debug/pi-acp-telegram-daemon',
    telegramConfig,
    relayEnv,
  );
  await until(() => sentText('echo: desktop while relay offline'), 'offline outbox delivery');
  const after = JSON.parse(await readFile(bindingFile, 'utf8'));
  assert.deepEqual(after.topics, before.topics);
  assert(after.offset >= before.offset);
  const delivered = () =>
    sent.filter(
      (item) =>
        item.method === 'sendMessage' &&
        item.params.text?.includes('echo: desktop while relay offline'),
    ).length;
  assert.equal(delivered(), 1);
  await delay(500);
  assert.equal(delivered(), 1);
  console.log('ok   relay restart preserves bindings and delivers offline desktop output once');
  console.log('\n5 Rust end-to-end integration checks passed (no real Bot or model)');
} finally {
  client?.close();
  for (const child of children.reverse()) await stop(child);
  await new Promise((resolve) => api.close(resolve));
  await rm(root, { recursive: true, force: true });
}
