#!/usr/bin/env node
// Black-box contract for the Telegram relay daemon. Two mocks stand in for the
// outside world — a Bot API HTTP server (PI_TELEGRAM_API_BASE) and a session
// service Unix socket — so the suite never touches Telegram or a real daemon.
//
//   node scripts/telegram-contract.mjs
//   PI_TG_DAEMON=/path/to/daemon node scripts/telegram-contract.mjs   (default: cargo build output)

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const DAEMON = (
  process.env.PI_TG_DAEMON || resolve('rust/target/contract/debug/pi-acp-telegram-daemon')
).split(/\s+/);
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CHAT = -1009999;
const USER = 42;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Telegram --
const telegram = {
  inbox: [],
  updates: [],
  updateId: 0,
  topic: 700,
  messageId: 1,
  topics: [],
  failures: [],
  attempts: [],
};
async function waitUntil(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}
const savedState = async () => JSON.parse(await readFile(stateFile(), 'utf8'));
const outboxFile = (id) =>
  join(dataDir, 'telegram', 'events', createHash('sha256').update(id).digest('hex') + '.json');
async function publishEvent(id, text, extra = {}) {
  const session = [...sessions.list.values()][0];
  await writeFile(
    outboxFile(id),
    JSON.stringify({
      id,
      sessionId: session.id,
      cwd: session.cwd,
      title: 'Contract',
      text,
      status: 'completed',
      updated: Date.now(),
      ...extra,
    }),
  );
}

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
      telegram.attempts.push({ method, params, at: Date.now() });
      const failure = telegram.failures.findIndex((rule) => rule.match(method, params));
      if (failure >= 0) {
        const [rule] = telegram.failures.splice(failure, 1);
        return res.end(
          JSON.stringify({
            ok: false,
            error_code: rule.code || 500,
            description: rule.description || 'synthetic transport failure',
            ...(rule.code === 429 ? { parameters: { retry_after: 1 } } : {}),
          }),
        );
      }
      switch (method) {
        case 'getMe':
          return reply({ id: 123, username: 'workbench_bot' });
        case 'getWebhookInfo':
          return reply({ url: telegram.webhook || '' });
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
const sessions = { list: new Map(), next: 0, watchers: new Map(), pending: new Map(), calls: [] };
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
        sessions.calls.push(item);
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
await symlink(workspace, join(root, 'allowed-alias'));
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
  child.logs = '';
  child.stderr.on('data', (d) => {
    child.logs = (child.logs + String(d)).slice(-65536);
    process.stderr.write(`[daemon] ${d}`);
  });
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`daemon exited ${code} before ready`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rej(error);
    });
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
  assert.equal(completion[0].params.disable_notification, false);
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
  message('queued-before-stop', { thread: state.threadId });
  message('/status', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('排队消息：2') });
  message('/stop', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('正在停止') });
  for (let i = 0; i < 100 && s.busy; i++) await delay(30);
  assert.equal(s.busy, false);
});

test('a new prompt after stop still executes, while the discarded queued prompt never executes', async () => {
  assert(
    !sessions.calls.some(
      (c) => c.method === 'prompt' && c.params.prompt[0].text === 'queued-before-stop',
    ),
  );
  message('after-stop', { thread: state.threadId });
  await waitSent('sendMessage', { text: 'echo: after-stop' });
  await waitUntil(
    async () => (await readdir(join(dataDir, 'telegram', 'events'))).length === 0,
    'pre-stop and post-stop events did not drain',
  );
  assert(
    !sessions.calls.some(
      (c) => c.method === 'prompt' && c.params.prompt[0].text === 'queued-before-stop',
    ),
  );
});

test('/notifications toggles persist and suppress outbox delivery', async () => {
  message('/notifications', { thread: state.threadId });
  const menu = await waitSent('sendMessage', {
    reply_markup: (m) => !!m && JSON.stringify(m).includes('notify:off'),
  });
  callback('notify:off', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已暂停全部会话推送' });
  const before = sent('sendMessage').length;
  const s = [...sessions.list.values()][0];
  message('hello again', { thread: state.threadId });
  await waitUntil(
    () => s.entries.at(-1)?.text === 'echo: hello again' && !s.busy,
    'muted prompt did not finish',
  );
  const eventId = `telegram-turn:${s.id}:${s.entries.length}`;
  await waitUntil(
    async () => (await savedState()).delivered.includes(eventId),
    'muted event was not durably acknowledged',
  );
  assert.equal(sent('sendMessage').length, before, 'muted completion produced chat messages');
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

test('duplicate update IDs are checkpointed once and never execute two prompts', async () => {
  const before = sessions.calls.filter((c) => c.method === 'prompt').length;
  message('deduplicated-update', { thread: state.threadId });
  const duplicate = telegram.updates.at(-1);
  telegram.updates.push(structuredClone(duplicate));
  await waitSent('sendMessage', { text: 'echo: deduplicated-update' });
  await waitUntil(
    async () => (await savedState()).offset > duplicate.update_id,
    'duplicate update offset was not saved',
  );
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, before + 1);
});

test('silence is persisted independently of delivery, and desktop input is not duplicated', async () => {
  callback('silent:on', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已开启静音发送' });
  assert.equal((await savedState()).notifications, true);
  assert.equal((await savedState()).silent, true);
  const id = 'desktop-silent';
  await publishEvent(id, 'desktop answer', { inputText: 'desktop question' });
  await waitUntil(
    async () => (await savedState()).delivered.includes(id),
    'silent completion was not acknowledged',
  );
  const body = sent('sendMessage', { text: (t) => t.includes?.('desktop question') });
  assert.equal(body.length, 1);
  assert.match(body[0].params.text, /desktop answer/);
  assert.equal(
    sent('sendMessage', { text: (t) => t.includes?.('任务完成') }).at(-1).params
      .disable_notification,
    true,
  );
  await publishEvent(id, 'desktop answer', { inputText: 'desktop question' });
  await waitUntil(async () => {
    try {
      await stat(outboxFile(id));
      return false;
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      throw e;
    }
  }, 'duplicate event was not removed');
  assert.equal(sent('sendMessage', { text: (t) => t.includes?.('desktop question') }).length, 1);
  callback('silent:off', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已关闭静音发送' });
});

test('a live stream observes silence changes made after its preview was created', async () => {
  const id = 'live-silence';
  await publishEvent(id, 'live preview', { status: 'running' });
  await waitSent('sendMessage', { text: 'live preview' });
  callback('silent:on', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已开启静音发送' });
  await publishEvent(id, 'full live answer');
  await waitUntil(
    async () => (await savedState()).delivered.includes(id),
    'live stream did not finish',
  );
  assert.equal(
    sent('sendMessage', { text: (t) => t.includes?.('任务完成') }).at(-1).params
      .disable_notification,
    true,
  );
  assert.equal(sent('editMessageText', { text: 'full live answer' }).length, 1);
  callback('silent:off', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已关闭静音发送' });
});

test('failed outbox delivery retries without re-running the service and redacts transport secrets', async () => {
  const id = 'delivery-retry',
    before = sessions.calls.filter((c) => c.method === 'prompt').length;
  telegram.failures.push({
    match: (method, p) => method === 'sendMessage' && p.text === 'retry body',
    description: `failure ${TOKEN}`,
  });
  await publishEvent(id, 'retry body');
  await waitUntil(
    () => telegram.attempts.some((c) => c.params.text === 'retry body'),
    'first delivery was not attempted',
  );
  await waitUntil(() => daemon.logs.includes('[redacted]'), 'transport error was not redacted');
  assert(!daemon.logs.includes(TOKEN));
  assert(!(await savedState()).delivered.includes(id));
  await stat(outboxFile(id));
  await waitUntil(
    async () => (await savedState()).delivered.includes(id),
    'failed delivery did not retry',
  );
  assert.equal(sent('sendMessage', { text: 'retry body' }).length, 1);
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, before);
});

test('429 retries the same send while preserving long Unicode output', async () => {
  const id = 'unicode-rate-limit',
    text = '😀'.repeat(5000) + 'rate-limit-tail';
  telegram.failures.push({
    match: (method, p) => method === 'sendMessage' && p.text?.startsWith('😀'),
    code: 429,
  });
  await publishEvent(id, text);
  await waitUntil(
    async () => (await savedState()).delivered.includes(id),
    'rate-limited Unicode event did not finish',
  );
  const chunks = sent('sendMessage', {
    text: (t) => t.startsWith?.('😀') || t === 'rate-limit-tail',
  }).map((c) => c.params.text);
  assert.equal(chunks.join(''), text);
  assert(chunks.every((c) => c.length <= 3900 && !/[\uD800-\uDBFF]$/.test(c)));
  const attempts = telegram.attempts.filter(
    (c) => c.method === 'sendMessage' && c.params.text === chunks[0],
  );
  assert(attempts.length >= 2);
  assert(attempts[1].at - attempts[0].at >= 900, '429 retry_after was not honored');
});

test('history sync checkpoints 100-entry batches and skips exported entries on repeated sync', async () => {
  const s = [...sessions.list.values()][0];
  s.entries = Array.from({ length: 101 }, (_, i) => ({
    id: `history-${i}`,
    role: 'user',
    text: `history-entry-${i}`,
  }));
  message('/history all', { thread: state.threadId });
  await waitUntil(
    async () => (await savedState()).historySent?.[s.id]?.length === 100,
    'first history batch was not checkpointed',
  );
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 100 条历史消息') });
  message('/history all', { thread: state.threadId });
  await waitUntil(
    async () => (await savedState()).historySent[s.id].length === 101,
    'second history batch did not continue',
  );
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 1 条历史消息') });
  const before = sent('sendMessage', { text: (t) => t.includes?.('history-entry-') }).length;
  message('/sync', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 0 个会话') });
  assert.equal(before, 101);
  assert.equal(sent('sendMessage', { text: (t) => t.includes?.('history-entry-') }).length, before);
});

test('failed history sends remain unacknowledged and can be retried', async () => {
  const s = [...sessions.list.values()][0];
  s.entries.push({ id: 'history-retry', role: 'user', text: 'history-retry' });
  telegram.failures.push({
    match: (method, p) => method === 'sendMessage' && p.text === '你：\nhistory-retry',
  });
  message('/history all', { thread: state.threadId });
  await waitUntil(() => telegram.failures.length === 0, 'history failure was not exercised');
  await delay(100);
  assert.equal((await savedState()).historySent[s.id].length, 101);
  message('/history all', { thread: state.threadId });
  await waitUntil(
    async () => (await savedState()).historySent[s.id].length === 102,
    'history retry did not commit',
  );
  assert.equal(sent('sendMessage', { text: '你：\nhistory-retry' }).length, 1);
});

test('/sync creates a topic once and retries failed history without importing it twice', async () => {
  const s = {
    id: 'sync-session',
    cwd: workspace,
    title: 'Sync session',
    number: ++sessions.next,
    busy: false,
    entries: [{ id: 'sync-entry', role: 'assistant', text: 'new-topic-history' }],
  };
  sessions.list.set(s.id, s);
  const topics = telegram.topics.length;
  telegram.failures.push({
    match: (method, p) => method === 'sendMessage' && p.text === 'Pi：\nnew-topic-history',
  });
  message('/sync', { thread: state.threadId });
  await waitUntil(
    () => telegram.failures.length === 0,
    'new-topic history failure was not exercised',
  );
  assert((await savedState()).topics.some((t) => t.sessionId === s.id));
  assert.equal((await savedState()).historySent[s.id]?.length || 0, 0);
  message('/sync', { thread: state.threadId });
  await waitUntil(
    async () => (await savedState()).historySent[s.id]?.length === 1,
    'new topic history retry did not commit',
  );
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 1 个会话') });
  assert.equal(telegram.topics.length, topics + 1);
  assert.equal(sent('sendMessage', { text: 'Pi：\nnew-topic-history' }).length, 1);
  message('/sync', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 0 个会话') });
  assert.equal(sent('sendMessage', { text: 'Pi：\nnew-topic-history' }).length, 1);
});

test('/help and /commands list all relay routes without executing prompts', async () => {
  const count = sessions.calls.filter((c) => c.method === 'prompt').length;
  message('/help', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('/commands') });
  const help = sent('sendMessage').at(-1).params.text;
  message('/commands', { thread: state.threadId });
  await waitUntil(
    () => sent('sendMessage', { text: help }).length === 2,
    'command alias did not return the help text',
  );
  for (const route of [
    'new',
    'sessions',
    'open',
    'sync',
    'history',
    'status',
    'stop',
    'interrupt',
    'notifications',
    'silent',
    'help',
    'commands',
    'start',
  ])
    assert(help.includes('/' + route));
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, count);
});

test('permission cards reject unauthorized, wrong-topic and invalid-option callbacks, then retire the ticket', async () => {
  message('ask', { thread: state.threadId });
  const cards = await waitSent('sendMessage', {
    reply_markup: (m) => m?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('p:'),
  });
  const data = cards[0].params.reply_markup.inline_keyboard[0][0].callback_data;
  const before = sessions.calls.filter((c) => c.method === 'permission').length;
  callback(data, { user: 99, thread: state.threadId });
  callback(data, { thread: state.threadId + 1 });
  callback(data.replace(/:0$/, ':999'), { thread: state.threadId });
  await delay(400);
  assert.equal(sessions.calls.filter((c) => c.method === 'permission').length, before);
  callback(data, { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: '已提交' });
  await waitSent('sendMessage', { text: (t) => t.includes?.('任务完成') });
  callback(data, { thread: state.threadId });
  await delay(400);
  assert.equal(sessions.calls.filter((c) => c.method === 'permission').length, before + 1);
});

test('canonical allowed directory aliases create sessions and repeated /open reuses the binding', async () => {
  const before = sessions.list.size;
  message(`/new ${join(root, 'allowed-alias')}`);
  await waitUntil(
    () => sessions.list.size === before + 1,
    'canonical alias did not create a session',
  );
  const created = [...sessions.list.values()].at(-1);
  assert.equal(created.cwd, workspace);
  const reply = `会话 #${created.number} 已连接到此话题。直接发文字开始；/stop 停止任务。`;
  await waitSent('sendMessage', { text: reply });
  const count = telegram.topics.length;
  for (let i = 2; i <= 3; i++) {
    message(`/open ${created.number}`);
    await waitUntil(
      () => sent('sendMessage', { text: reply }).length === i,
      'open did not reuse the topic',
    );
  }
  assert.equal(telegram.topics.length, count);
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

test('cursor write failure stops dispatch and restart retains the last durable offset', async () => {
  const before = await savedState(),
    calls = sessions.calls.filter((c) => c.method === 'prompt').length,
    backup = stateFile() + '.backup';
  await rename(stateFile(), backup);
  await mkdir(stateFile());
  try {
    message('must-not-execute', { thread: state.threadId });
    await waitUntil(
      () => daemon.exitCode !== null,
      'relay did not stop after cursor storage failure',
    );
    assert.notEqual(daemon.exitCode, 0);
    assert(daemon.logs.includes('无法保存 Telegram 游标'));
    assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, calls);
    assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), before);
  } finally {
    await rm(stateFile(), { recursive: true, force: true });
    await rename(backup, stateFile());
  }
  daemon = startDaemon();
  await ready(daemon);
  assert.equal((await savedState()).offset, before.offset);
  message('/status', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('排队消息') });
});

test('an existing webhook prevents startup without dispatch or state changes', async () => {
  await stopDaemon(daemon);
  const before = await savedState(),
    calls = sessions.calls.filter((c) => c.method === 'prompt').length;
  telegram.webhook = 'https://existing.invalid/hook';
  const blocked = startDaemon();
  try {
    await assert.rejects(ready(blocked), /before ready/);
    assert(blocked.logs.includes('已配置 webhook'));
    assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, calls);
    assert.deepEqual(await savedState(), before);
  } finally {
    telegram.webhook = '';
    await stopDaemon(blocked);
  }
  daemon = startDaemon();
  await ready(daemon);
});

let failures = 0;
let daemon = startDaemon();
try {
  await ready(daemon);
  for (const { name, fn } of tests) {
    try {
      telegram.inbox.length = 0;
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
