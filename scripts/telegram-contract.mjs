#!/usr/bin/env node
// Black-box contract for the Telegram relay daemon. Two mocks stand in for the
// outside world — a Bot API HTTP server (PI_TELEGRAM_API_BASE) and a session
// service Unix socket — so the suite never touches Telegram or a real daemon.
//
//   node scripts/telegram-contract.mjs
//   PI_TG_DAEMON="node dist/telegram-daemon.mjs" node scripts/telegram-contract.mjs  (TypeScript)
//   PI_TG_DAEMON=/path/to/daemon node scripts/telegram-contract.mjs   (default: cargo build output)

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const DAEMON = (
  process.env.PI_TG_DAEMON || resolve('rust/target/contract/debug/pi-acp-telegram-daemon')
).split(/\s+/);
// Keep the familiar TS selector, but launch a test-only dependency-injection entry.
if (DAEMON[0] === 'node' && DAEMON[1]?.endsWith('dist/telegram-daemon.mjs'))
  DAEMON[1] = resolve('test/telegram-contract-entry.mjs');
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CHAT = -1009999;
const USER = 42;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Telegram --
const telegram = { inbox: [], updates: [], updateId: 0, topic: 700, messageId: 1, topics: [] };
function pushUpdate(body) {
  telegram.updates.push({ update_id: ++telegram.updateId, ...body });
}
function message(text, { user = USER, thread, chat = CHAT } = {}) {
  pushUpdate({
    message: {
      message_id: telegram.messageId++,
      chat: { id: chat, type: 'supergroup' },
      from: { id: user },
      text,
      ...(thread ? { message_thread_id: thread } : {}),
    },
  });
}
function callback(data, { user = USER, thread } = {}) {
  pushUpdate({
    callback_query: {
      id: `cb${telegram.updateId}`,
      from: { id: user },
      data,
      message: {
        message_id: 88,
        chat: { id: CHAT, type: 'supergroup' },
        ...(thread ? { message_thread_id: thread } : {}),
      },
    },
  });
}
const sent = (method, match = {}) =>
  telegram.inbox.filter(
    (i) =>
      i.method === method &&
      Object.entries(match).every(([k, v]) =>
        typeof v === 'function' ? v(i.params[k]) : i.params[k] === v,
      ),
  );
async function waitSent(method, match, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = sent(method, match);
    if (found.length) return found;
    await delay(25);
  }
  throw new Error(
    `no ${method} within ${timeout}ms\ninbox: ${JSON.stringify(telegram.inbox.map((i) => [i.method, typeof i.params.text === 'string' ? i.params.text.slice(0, 60) : undefined]))}`,
  );
}

async function startTelegramMock() {
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const method = req.url.replace(/^\//, '');
      const params = JSON.parse(body || '{}');
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      switch (method) {
        case 'getMe':
          return reply({ id: 123, username: 'workbench_bot' });
        case 'getWebhookInfo':
          return reply({ url: '' });
        case 'getChat':
          return reply({ id: CHAT, type: 'supergroup', is_forum: true });
        case 'getUpdates': {
          // Hold briefly so the daemon isn't a busy loop when idle.
          const deadline = Date.now() + (params.timeout === 0 ? 0 : 300);
          while (Date.now() < deadline && !telegram.updates.length) await delay(15);
          const offset = params.offset || 0;
          const batch = telegram.updates.filter((u) => u.update_id >= offset);
          telegram.updates = telegram.updates.filter((u) => u.update_id < offset);
          return reply(params.offset === -1 ? telegram.updates.splice(0) : batch);
        }
        case 'createForumTopic': {
          telegram.inbox.push({ method, params });
          const threadId = ++telegram.topic;
          telegram.topics.push(threadId);
          return reply({ message_thread_id: threadId });
        }
        case 'sendMessage':
        case 'editMessageText':
          telegram.inbox.push({ method, params });
          return reply({ message_id: telegram.messageId++ });
        case 'answerCallbackQuery':
          telegram.inbox.push({ method, params });
          return reply(true);
        default:
          telegram.inbox.push({ method, params });
          return reply({});
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// ------------------------------------------------------------ session mock --
const sessions = { list: new Map(), next: 0, watchers: new Map(), pending: new Map() };
function snapshot(s) {
  return {
    id: s.id,
    harness: 'pi',
    cwd: s.cwd,
    title: s.title,
    sessionNumber: s.number,
    entries: s.entries,
    stored: true,
  };
}
function notifyWatchers(sessionId, event) {
  for (const [socket, set] of sessions.watchers) {
    if (!set.has(sessionId) || socket.destroyed) continue;
    socket.write(JSON.stringify({ event }) + '\n');
  }
}
function completePrompt(s, stopReason) {
  const pending = sessions.pending.get(s.id);
  if (!pending) return;
  sessions.pending.delete(s.id);
  s.busy = false;
  pending.resolve({ stopReason });
}
function startSessionMock(socketPath, outboxDir) {
  const writeEvent = async (event) => {
    await mkdir(outboxDir, { recursive: true });
    const file = join(outboxDir, createHash('sha256').update(event.id).digest('hex') + '.json');
    await writeFile(file, JSON.stringify(event));
  };
  const server = createSocketServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const item = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const ok = (value) => socket.write(JSON.stringify({ id: item.id, value }) + '\n');
        const fail = (error) => socket.write(JSON.stringify({ id: item.id, error }) + '\n');
        try {
          switch (item.method) {
            case 'hello':
              ok({ protocolVersion: 1 });
              break;
            case 'list':
              ok([...sessions.list.values()].map(snapshot));
              break;
            case 'create': {
              const s = {
                id: randomUUID(),
                cwd: item.params.cwd,
                title: '',
                number: ++sessions.next,
                entries: [],
                busy: false,
              };
              sessions.list.set(s.id, s);
              ok(snapshot(s));
              break;
            }
            case 'state': {
              const s = sessions.list.get(item.params.sessionId);
              if (!s) return fail('会话不存在');
              ok({ snapshot: snapshot(s), busy: s.busy, permissions: s.permissions || [] });
              break;
            }
            case '_watch': {
              const set = sessions.watchers.get(socket) || new Set();
              item.params.enabled
                ? set.add(item.params.sessionId)
                : set.delete(item.params.sessionId);
              sessions.watchers.set(socket, set);
              ok(true);
              break;
            }
            case 'prompt': {
              const s = sessions.list.get(item.params.sessionId);
              if (!s) return fail('会话不存在');
              const text = item.params.prompt[0].text;
              s.entries.push({ id: `u${s.entries.length}`, role: 'user', text });
              s.busy = true;
              const turn = new Promise((resolve) => sessions.pending.set(s.id, { resolve }));
              (async () => {
                if (text === 'ask') {
                  s.permissions = [
                    {
                      id: 'perm-1',
                      request: {
                        options: [
                          { optionId: 'yes', name: '允许执行' },
                          { optionId: 'no', name: '拒绝' },
                        ],
                        toolCall: { title: '执行工具', kind: 'execute' },
                      },
                    },
                  ];
                  notifyWatchers(s.id, {
                    type: 'state',
                    snapshot: snapshot(s),
                    permissions: s.permissions,
                  });
                }
                if (text !== 'wait') {
                  // 'ask' resolves once permission arrives; others complete now.
                  if (text !== 'ask') {
                    s.entries.push({
                      id: `a${s.entries.length}`,
                      role: 'assistant',
                      text: `echo: ${text}`,
                    });
                    completePrompt(s, 'end_turn');
                  }
                }
                const result = await turn;
                s.busy = false;
                s.permissions = [];
                s.title ||= text.slice(0, 30);
                await writeEvent({
                  id: `telegram-turn:${s.id}:${s.entries.length}`,
                  sessionId: s.id,
                  cwd: s.cwd,
                  title: s.title,
                  sessionNumber: s.number,
                  text: `echo: ${text}`,
                  status: result.stopReason === 'end_turn' ? 'completed' : 'cancelled',
                  updated: Date.now(),
                });
                ok(result);
              })();
              break;
            }
            case 'cancel': {
              const s = sessions.list.get(item.params.sessionId);
              if (!s || !s.busy) {
                ok(false);
                break;
              }
              completePrompt(s, 'cancelled');
              ok(true);
              break;
            }
            case 'permission': {
              const s = sessions.list.get(item.params.sessionId);
              if (!s?.permissions?.length) {
                ok(false);
                break;
              }
              s.permissions = [];
              completePrompt(s, 'end_turn');
              ok(true);
              break;
            }
            default:
              fail('未知服务操作');
          }
        } catch (e) {
          fail(String(e));
        }
      }
    });
    socket.on('close', () => sessions.watchers.delete(socket));
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(socketPath, () => res(server));
  });
}

// ----------------------------------------------------------------- runner ---
const root = await mkdtemp(join(tmpdir(), 'pi-tg-contract-'));
const workspace = join(root, 'workspace');
const dataDir = join(root, 'data');
await mkdir(workspace, { recursive: true });
await symlink(root, join(workspace, 'escape'));
await mkdir(join(dataDir, 'service'), { recursive: true });
const configFile = join(root, 'telegram.json');
await writeFile(
  configFile,
  JSON.stringify({
    chatId: CHAT,
    allowedUserIds: [USER],
    workspaces: { main: workspace },
    restrictToWorkspaces: true,
  }),
);

const tg = await startTelegramMock();
const socketPath = join(dataDir, 'service', 'sessions.sock');
const sessionServer = await startSessionMock(socketPath, join(dataDir, 'telegram', 'events'));

const stateFile = () => join(dataDir, 'telegram', 'bot-123-chat-' + CHAT + '.json');
function startDaemon() {
  const child = spawn(
    DAEMON[0],
    [...DAEMON.slice(1), '--config', configFile, '--data-dir', dataDir],
    {
      env: {
        ...process.env,
        PI_TELEGRAM_BOT_TOKEN: TOKEN,
        PI_TELEGRAM_API_BASE: tg.base,
        PI_TELEGRAM_PACE_MS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  return child;
}
async function ready(child) {
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('daemon not ready in 15s')), 15000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('ready')) {
        clearTimeout(timer);
        res();
      }
    });
    child.on('exit', (code) => rej(new Error(`daemon exited ${code} before ready`)));
  });
}
async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(8000)]);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let state = {};

test('startup binds, checkpoints the offset and accepts commands', async () => {
  state.topic = undefined;
  message('/sessions');
  const replies = await waitSent('sendMessage', { text: '暂无会话。发送 /new 创建。' });
  assert(replies.length >= 1);
  const saved = JSON.parse(await readFile(stateFile(), 'utf8'));
  assert.equal(saved.botId, 123);
  assert.ok(saved.offset >= 1);
});

test('messages from other users and chats are ignored', async () => {
  const before = telegram.inbox.length;
  message('secret attempt', { user: 99 });
  message('wrong chat', { chat: -555 });
  await delay(400);
  assert.equal(telegram.inbox.length, before);
});

test('/new rejects a symlink escape from restricted workspaces', async () => {
  message(`/new ${join(workspace, 'escape')}`);
  await waitSent('sendMessage', { text: (t) => t.includes?.('目录不在允许的 workspaces 中') });
  assert.equal(sessions.list.size, 0);
});

test('/new creates a session, a topic and binds them', async () => {
  message('/new main');
  await waitSent('createForumTopic');
  state.threadId = telegram.topics.at(-1);
  const reply = await waitSent('sendMessage', { message_thread_id: state.threadId });
  assert.match(reply[0].params.text, /已连接到此话题/);
  assert.equal(sessions.list.size, 1);
});

test('plain text runs the prompt and the outbox reply lands in the topic', async () => {
  message('hello pi', { thread: state.threadId });
  const completion = await waitSent('sendMessage', { text: (t) => t.includes?.('任务完成') });
  assert.match(completion[0].params.text, /任务完成/);
  const body = sent('sendMessage', { message_thread_id: state.threadId });
  assert.ok(body.some((m) => /echo: hello pi/.test(m.params.text)));
  const s = [...sessions.list.values()][0];
  assert.equal(s.entries.at(-1).text, 'echo: hello pi');
});

test('permission cards carry buttons and callbacks reach the service', async () => {
  message('ask', { thread: state.threadId });
  const card = await waitSent('sendMessage', { reply_markup: (m) => !!m });
  const button = card[0].params.reply_markup.inline_keyboard[0][0];
  assert.match(button.callback_data, /^p:[a-f0-9]{20}:0$/);
  callback(button.callback_data, { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已提交' });
  const s = [...sessions.list.values()][0];
  for (let i = 0; i < 100 && s.busy; i++) await delay(30);
  assert.equal(s.busy, false);
});

test('/stop cancels an in-flight turn and drops queued work', async () => {
  message('wait', { thread: state.threadId });
  await delay(300);
  const s = [...sessions.list.values()][0];
  assert.equal(s.busy, true);
  message('/stop', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('正在停止') });
  for (let i = 0; i < 100 && s.busy; i++) await delay(30);
  assert.equal(s.busy, false);
});

test('/notifications toggles persist and suppress outbox delivery', async () => {
  message('/notifications', { thread: state.threadId });
  const menu = await waitSent('sendMessage', {
    reply_markup: (m) => !!m && JSON.stringify(m).includes('notify:off'),
  });
  callback('notify:off', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已暂停全部会话推送' });
  const before = sent('sendMessage').length;
  message('hello again', { thread: state.threadId });
  await delay(1500); // turn completes; outbox event consumed and marked delivered silently
  const after = sent('sendMessage').length;
  assert.ok(after - before <= 1, 'completed event should not produce chat messages while muted');
  const saved = JSON.parse(await readFile(stateFile(), 'utf8'));
  assert.equal(saved.notifications, false);
  assert.ok(saved.delivered.length >= 1);
  callback('notify:on', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已开启全部会话推送' });
});

test('/status reports the bound session state', async () => {
  message('/status', { thread: state.threadId });
  const replies = await waitSent('sendMessage', {
    text: (t) => t.includes?.('空闲') || t.includes?.('正在执行'),
  });
  assert.match(replies.at(-1).params.text, /排队消息/);
});

test('a second daemon refuses the same data directory', async () => {
  const second = startDaemon();
  const code = await Promise.race([
    new Promise((r) => second.once('exit', r)),
    delay(5000).then(() => 'timeout'),
  ]);
  assert.notEqual(code, 0);
  assert.notEqual(code, 'timeout');
  if (code === 'timeout') second.kill('SIGKILL');
});

let failures = 0;
const daemon = startDaemon();
try {
  await ready(daemon);
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failures++;
      console.log(`FAIL ${name}\n     ${error.stack || error}`);
    }
  }
} finally {
  await stopDaemon(daemon);
  sessionServer.close();
  tg.server.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  failures
    ? `\n${failures} telegram contract test(s) failed`
    : `\n${tests.length} telegram contract tests passed`,
);
process.exitCode = failures ? 1 : 0;
