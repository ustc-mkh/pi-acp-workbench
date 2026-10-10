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
function message(text, { user = USER, thread, chat = CHAT, reply } = {}) {
  pushUpdate({
    message: {
      message_id: telegram.messageId++,
      chat: { id: chat, type: 'supergroup' },
      from: { id: user },
      text,
      ...(reply
        ? {
            reply_to_message: {
              message_id: reply.messageId,
              text: reply.params.text,
              from: { id: 123, is_bot: true },
            },
          }
        : {}),
      ...(thread ? { message_thread_id: thread } : {}),
    },
  });
}
function callback(data, { user = USER, thread, messageId = 88 } = {}) {
  pushUpdate({
    callback_query: {
      id: `cb${telegram.updateId}`,
      from: { id: user },
      data,
      message: {
        message_id: messageId,
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

const panels = () =>
  telegram.inbox.filter((c) =>
    c.params.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data?.startsWith('ui:')),
  );
async function panelWith(text) {
  let panel;
  await waitUntil(() => {
    panel = panels().findLast((c) => c.params.text.includes(text));
    return panel;
  }, `no panel containing ${text}`);
  return panel;
}
function click(panel, label, options = {}) {
  const button = panel.params.reply_markup.inline_keyboard
    .flat()
    .find((b) => (typeof label === 'string' ? b.text === label : label.test(b.text)));
  assert(button, `missing button ${label} on ${panel.params.text}`);
  callback(button.callback_data, {
    thread: panel.params.message_thread_id,
    messageId: panel.messageId,
    ...options,
  });
  return button.callback_data;
}

async function startTelegramMock() {
  const server = createHttpServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const method = req.url.replace(/^\//, '');
      const body = Buffer.concat(parts);
      let params;
      if (req.headers['content-type']?.startsWith('multipart/form-data')) {
        params = {};
        const form = await new Request('http://localhost/', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] },
          body,
        }).formData();
        for (const [key, value] of form) {
          params[key] =
            typeof value === 'string'
              ? ['chat_id', 'message_thread_id', 'disable_notification'].includes(key)
                ? JSON.parse(value)
                : value
              : {
                  name: value.name,
                  mimeType: value.type,
                  data: Buffer.from(await value.arrayBuffer()).toString('base64'),
                };
        }
      } else params = JSON.parse(body.toString() || '{}');
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
          // A stopped daemon can leave a mock long poll in flight. It must not
          // consume updates intended for the replacement daemon after disconnect.
          if (res.destroyed) return;
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
        case 'sendPhoto':
        case 'sendAnimation':
        case 'sendDocument':
        case 'sendMessage':
        case 'editMessageText': {
          const messageId = method === 'editMessageText' ? params.message_id : telegram.messageId++;
          telegram.inbox.push({ method, params, messageId });
          return reply({ message_id: messageId });
        }
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
const failedAcks = new Set();
const sessions = { list: new Map(), next: 0, watchers: new Map(), pending: new Map(), calls: [] };
const defaultConfigs = () => [
  {
    id: 'model',
    type: 'select',
    category: 'model',
    name: 'Model',
    currentValue: 'm0',
    options: [
      {
        name: 'Provider',
        options: Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, name: `Model ${i}` })),
      },
    ],
  },
  {
    id: 'effort',
    type: 'select',
    category: 'thought_level',
    name: 'Reasoning',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];
function snapshot(s) {
  return {
    id: s.id,
    harness: s.harness || 'pi',
    updated: s.updated ?? s.number,
    cwd: s.cwd,
    title: s.title,
    sessionNumber: s.number,
    entries: s.entries,
    configs: s.configs || defaultConfigs(),
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
            case 'events.next': {
              const names = (
                await readdir(outboxDir).catch((error) => {
                  if (error.code === 'ENOENT') return [];
                  throw error;
                })
              )
                .filter(
                  (name) =>
                    /^[a-f0-9]{64}\.json$/.test(name) &&
                    (!item.params.cursor || name > item.params.cursor),
                )
                .sort();
              if (!names.length) {
                ok(null);
                break;
              }
              const cursor = names[0],
                body = await readFile(join(outboxDir, cursor));
              ok({
                cursor,
                event: JSON.parse(body),
                token: createHash('sha256').update(body).digest('hex'),
              });
              break;
            }
            case 'events.ack': {
              if (failedAcks.has(item.params.id)) {
                fail('simulated acknowledgement transport failure');
                break;
              }
              const file = join(
                outboxDir,
                createHash('sha256').update(item.params.id).digest('hex') + '.json',
              );
              let body;
              try {
                body = await readFile(file);
              } catch (error) {
                if (error.code === 'ENOENT') {
                  ok(false);
                  break;
                }
                throw error;
              }
              if (createHash('sha256').update(body).digest('hex') !== item.params.token) {
                ok(false);
                break;
              }
              await rm(file);
              ok(true);
              break;
            }
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
                harness: item.params.harness || 'pi',
                configs: defaultConfigs(),
                updated: Date.now(),
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
            case 'request': {
              const s = sessions.list.get(item.params.sessionId);
              if (!s) return fail('会话不存在');
              assert.equal(item.params.method, 'session/set_config_option');
              const config = s.configs.find((c) => c.id === item.params.params.configId);
              const options = config?.options.flatMap((o) => o.options || [o]);
              if (!options?.some((o) => o.value === item.params.params.value))
                return fail('无效选项');
              config.currentValue = item.params.params.value;
              if (config.id === 'model' && config.currentValue === 'm10') {
                s.configs[1].options = [{ value: 'low', name: 'Low' }];
                s.configs[1].currentValue = 'low';
              }
              ok({ configOptions: s.configs });
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
  click(await panelWith('选择 Harness'), /Pi$/);
  await waitSent('createForumTopic');
  state.threadId = telegram.topics.at(-1);
  const reply = await waitSent('sendMessage', { message_thread_id: state.threadId });
  assert.match(reply[0].params.text, /Harness：pi/);
  assert.equal(sessions.list.size, 1);
  await waitUntil(
    async () => ((await savedState()).inbox || []).length === 0,
    'new-session wizard did not finish',
  );
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
  message('/notifications');
  const menu = await waitSent('sendMessage', {
    reply_markup: (m) => !!m && JSON.stringify(m).includes('notify:off'),
  });
  callback('notify:off');
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
  callback('notify:on');
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
  callback('silent:on');
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
  callback('silent:off');
  await waitSent('answerCallbackQuery', { text: '已关闭静音发送' });
});

test('a live stream observes silence changes made after its preview was created', async () => {
  const id = 'live-silence';
  await publishEvent(id, 'live preview', { status: 'running' });
  await waitSent('sendMessage', { text: 'live preview' });
  callback('silent:on');
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
  callback('silent:off');
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

test('socket acknowledgement failure retries without resending a durably delivered reply', async () => {
  const id = 'rpc-ack-retry';
  failedAcks.add(id);
  try {
    await publishEvent(id, 'ack retry body');
    await waitUntil(
      async () => (await savedState()).delivered.includes(id),
      'delivery checkpoint missing',
    );
    await waitUntil(
      () => sessions.calls.some((call) => call.method === 'events.ack' && call.params.id === id),
      'ack was not attempted',
    );
    await stat(outboxFile(id));
    assert.equal(sent('sendMessage', { text: 'ack retry body' }).length, 1);
  } finally {
    failedAcks.delete(id);
  }
  await waitUntil(async () => {
    try {
      await stat(outboxFile(id));
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }, 'acknowledged event was not removed');
  assert.equal(sent('sendMessage', { text: 'ack retry body' }).length, 1);
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
  message('/sync');
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
  message('/sync');
  await waitUntil(
    () => telegram.failures.length === 0,
    'new-topic history failure was not exercised',
  );
  assert((await savedState()).topics.some((t) => t.sessionId === s.id));
  assert.equal((await savedState()).historySent[s.id]?.length || 0, 0);
  message('/sync');
  await waitUntil(
    async () => (await savedState()).historySent[s.id]?.length === 1,
    'new topic history retry did not commit',
  );
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 1 个会话') });
  assert.equal(telegram.topics.length, topics + 1);
  assert.equal(sent('sendMessage', { text: 'Pi：\nnew-topic-history' }).length, 1);
  message('/sync');
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 0 个会话') });
  assert.equal(sent('sendMessage', { text: 'Pi：\nnew-topic-history' }).length, 1);
});

test('/sync uses updated order: latest five get ten, older sessions get two, and never backfills on repeat', async () => {
  const sample = Array.from({ length: 7 }, (_, i) => ({
    id: `preview-${i}`,
    cwd: workspace,
    title: `Preview ${i}`,
    number: ++sessions.next,
    updated: 1e15 + i,
    busy: false,
    entries: Array.from({ length: 25 }, (_, n) => ({
      id: `preview-${i}-${n}`,
      role: n % 2 ? 'assistant' : 'user',
      text: `preview-entry-${i}-${n}`,
    })),
  }));
  for (const i of [3, 0, 6, 1, 5, 2, 4]) sessions.list.set(sample[i].id, sample[i]);
  message('/sync');
  await waitSent('sendMessage', {
    text: (t) => t.startsWith?.('已同步') && t.includes('最新 5 个会话各取最后 10 条'),
  });
  const saved = await savedState();
  for (let i = 0; i < sample.length; i++) {
    const count = i >= 2 ? 10 : 2;
    assert.equal(saved.historySent[sample[i].id].length, count);
    const output = sent('sendMessage', { text: (t) => t.includes?.(`preview-entry-${i}-`) });
    assert.deepEqual(
      output.map((c) => Number(c.params.text.split(`preview-entry-${i}-`)[1])),
      Array.from({ length: count }, (_, n) => 25 - count + n),
    );
  }
  const before = sent('sendMessage', { text: (t) => t.includes?.('preview-entry-') }).length;
  message('/sync');
  await waitSent('sendMessage', { text: (t) => t.startsWith?.('已同步 0 个会话') });
  assert.equal(sent('sendMessage', { text: (t) => t.includes?.('preview-entry-') }).length, before);
  message('/syncall');
  await waitSent('sendMessage', { text: (t) => t.includes?.('/syncall 已移除') });
  assert(
    !sessions.calls.some((c) => c.method === 'prompt' && c.params.prompt?.[0]?.text === '/syncall'),
  );
});

test('/help and /commands list all relay routes without executing prompts', async () => {
  const count = sessions.calls.filter((c) => c.method === 'prompt').length;
  message('/help', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('/commands') });
  const help = sent('sendMessage').find((c) => c.params.text.includes('/commands')).params.text;
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
    'menu',
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
  assert(!help.includes('/settings'));
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, count);
});

test('outbox messages reach Bot API with Markdown entities and structured attachment notices', async () => {
  const id = 'markdown-entities';
  await publishEvent(id, '**粗体** 与 `😀<>&` [链接](https://example.com)', {
    inputText: 'question',
    nonTextBlocks: 2,
  });
  await waitUntil(
    async () => (await savedState()).delivered.includes(id),
    'Markdown event was not delivered',
  );
  const calls = [...sent('sendMessage'), ...sent('editMessageText')].filter((call) =>
    call.params.text?.includes('粗体 与 😀<>& 链接'),
  );
  assert(calls.length > 0);
  for (const { params } of calls) {
    assert(params.text.includes('附带 2 个非文本内容'));
    const units = params.text.split('');
    assert(
      params.entities.some(
        (e) => e.type === 'bold' && units.slice(e.offset, e.offset + e.length).join('') === '粗体',
      ),
    );
    assert(
      params.entities.some(
        (e) => e.type === 'code' && units.slice(e.offset, e.offset + e.length).join('') === '😀<>&',
      ),
    );
    assert(params.entities.some((e) => e.type === 'text_link' && e.url === 'https://example.com'));
    assert.equal(params.parse_mode, undefined);
  }
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
  click(await panelWith('选择 Harness'), /Pi$/);
  await waitUntil(
    () => sessions.list.size === before + 1,
    'canonical alias did not create a session',
  );
  const created = [...sessions.list.values()].at(-1);
  assert.equal(created.cwd, workspace);
  const reply = `会话 #${created.number} 已连接到此话题。直接发文字开始；/stop 停止任务。`;
  await waitSent('sendMessage', {
    text: (t) => t.includes?.('Harness：pi') && t.includes(`#${created.number}`),
  });
  const count = telegram.topics.length;
  for (let i = 1; i <= 2; i++) {
    message(`/open ${created.number}`);
    await waitUntil(
      () => sent('sendMessage', { text: reply }).length === i,
      'open did not reuse the topic',
    );
  }
  assert.equal(telegram.topics.length, count);
});

test('inline model pagination updates actual settings, refreshes effort, and rejects stale or misplaced buttons', async () => {
  const session = [...sessions.list.values()][0];
  const count = sessions.calls.filter((c) => c.method === 'request').length;
  message('/menu', { thread: state.threadId });
  const settings = await panelWith('Harness：pi');
  const original = settings.params.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.text === '选择模型').callback_data;
  callback(original, { thread: state.threadId + 999, messageId: settings.messageId });
  callback(original, { thread: state.threadId, messageId: settings.messageId + 999 });
  callback(original, { user: 99, thread: state.threadId, messageId: settings.messageId });
  await waitSent('answerCallbackQuery', { text: (t) => t.includes?.('按钮已失效') });
  assert.equal(sessions.calls.filter((c) => c.method === 'request').length, count);
  click(settings, '选择模型');
  const first = await panelWith('选择模型 · 第 1/2 页');
  click(first, '下一页');
  const second = await panelWith('选择模型 · 第 2/2 页');
  const stale = second.params.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.text.includes('Model 11')).callback_data;
  click(second, /Model 10$/);
  await waitUntil(() => session.configs[0].currentValue === 'm10', 'model was not applied');
  await waitUntil(
    () =>
      panels().some(
        (p) =>
          p.params.text.includes('模型：Provider · Model 10') &&
          p.params.text.includes('思考强度：Low'),
      ),
    'settings did not reflect dependent effort change',
  );
  callback(stale, { thread: state.threadId, messageId: second.messageId });
  await waitUntil(
    async () => ((await savedState()).inbox || []).length === 0,
    'stale callback did not finish',
  );
  assert.equal(session.configs[0].currentValue, 'm10');
  assert.equal(sessions.calls.filter((c) => c.method === 'request').length, count + 1);
  const refreshed = panels().findLast((p) => p.params.text.includes('设置已更新'));
  click(refreshed, '选择思考强度');
  const effort = await panelWith('选择思考强度 ·');
  assert.equal(
    effort.params.reply_markup.inline_keyboard.flat().filter((b) => /Low|High/.test(b.text)).length,
    1,
  );
  click(effort, /Low$/);
  await waitUntil(
    () => sessions.calls.filter((c) => c.method === 'request').length === count + 2,
    'effort request did not reach service',
  );
});

test('settings buttons reject changes during a task and preserve the active prompt', async () => {
  const session = [...sessions.list.values()][0];
  const count = sessions.calls.filter((c) => c.method === 'request').length;
  message('wait', { thread: state.threadId });
  await waitUntil(() => session.busy, 'held task was not started');
  message('/menu', { thread: state.threadId });
  const settings = await panelWith('Harness：pi');
  click(settings, '选择模型');
  const options = await panelWith('选择模型 ·');
  click(options, /Model 0$/);
  await waitUntil(
    () => panels().some((p) => p.params.text.includes('任务正在执行或排队')),
    'busy settings change did not show a clear message',
  );
  assert(session.busy);
  assert.equal(sessions.calls.filter((c) => c.method === 'request').length, count);
  message('/stop', { thread: state.threadId });
  await waitUntil(() => !session.busy, 'held task did not stop');
});

test('new-session wizard accepts a directory reply, selects Codex, and consumes duplicate create clicks once', async () => {
  const before = sessions.list.size;
  const prompts = sessions.calls.filter((c) => c.method === 'prompt').length;
  message('/new');
  const projects = await panelWith('选择项目');
  click(projects, '输入其他目录');
  const [prompt] = await waitSent('sendMessage', {
    text: (t) => t.startsWith?.('请输入服务器上的绝对目录路径'),
  });
  assert.equal(prompt.params.reply_markup.force_reply, true);
  message(workspace, { reply: prompt });
  const harness = await panelWith('选择 Harness');
  const data = click(harness, /Codex$/);
  callback(data, { messageId: harness.messageId });
  await waitUntil(() => sessions.list.size === before + 1, 'Codex session was not created');
  await waitUntil(
    async () => ((await savedState()).inbox || []).length === 0,
    'wizard callbacks did not finish',
  );
  const created = [...sessions.list.values()].at(-1);
  assert.equal(created.harness, 'codex');
  assert.equal(created.cwd, workspace);
  assert.equal(sessions.list.size, before + 1);
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, prompts);
  await waitSent('sendMessage', { text: (t) => t.includes?.('Harness：codex') });
  message(workspace, { reply: prompt });
  await waitSent('sendMessage', { text: (t) => t.includes?.('目录输入已失效') });
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, prompts);
});

test('a cancelled wizard creates no session', async () => {
  const before = sessions.list.size;
  message('/new');
  click(await panelWith('选择项目'), '取消');
  await waitUntil(
    () => sent('editMessageText', { text: (t) => t.startsWith?.('已取消') }).length > 0,
    'wizard was not cancelled',
  );
  assert.equal(sessions.list.size, before);
});

test('General and session menus are isolated, include sync controls, and retire /settings', async () => {
  const openMenu = async (thread) => {
    const start = telegram.inbox.length;
    message('/menu', { thread });
    let result;
    await waitUntil(
      () =>
        (result = telegram.inbox
          .slice(start)
          .findLast((c) =>
            c.params.reply_markup?.inline_keyboard
              ?.flat()
              .some((b) => b.callback_data?.startsWith('ui:')),
          )),
      'new menu missing',
    );
    return result;
  };
  const general = await openMenu(1);
  const rows = general.params.reply_markup.inline_keyboard;
  assert.deepEqual(
    rows[0].map((b) => b.text),
    ['➕ 新建会话', '📂 已有会话'],
  );
  assert(rows.flat().some((b) => b.text === '同步历史摘要'));
  assert(rows.flat().some((b) => b.text === '自动推送：开启'));
  assert(!rows.flat().some((b) => b.text === '停止任务'));
  click(general, '自动推送：开启');
  await waitUntil(async () => (await savedState()).notifications === false, 'menu mute missing');
  click(await panelWith('已暂停全部会话推送'), '自动推送：关闭');
  await waitUntil(async () => (await savedState()).notifications === true, 'menu unmute missing');
  const topic = await openMenu(state.threadId);
  const labels = topic.params.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert(labels.includes('同步最近的消息'));
  assert(labels.includes('刷新面板'));
  assert(!labels.some((t) => /主菜单|管理菜单|新建|已有会话|更多历史|推送|静音/.test(t)));
  const s = [...sessions.list.values()][0];
  s.entries.push({ id: 'topic-menu-recent', role: 'assistant', text: 'topic-menu-recent' });
  click(topic, '同步最近的消息');
  await waitSent('sendMessage', {
    text: 'Pi：\ntopic-menu-recent',
    message_thread_id: state.threadId,
  });
  const prompts = sessions.calls.filter((c) => c.method === 'prompt').length;
  message('/settings', { thread: state.threadId });
  await waitSent('sendMessage', { text: '/settings 已移除，请使用 /menu。' });
  message('/new', { thread: state.threadId });
  await waitSent('sendMessage', { text: (t) => t.includes?.('请在 General 使用 /menu') });
  message('/menu', { thread: 999999 });
  await waitSent('sendMessage', { text: (t) => t.includes?.('此话题未绑定会话') });
  callback('notify:off', { thread: state.threadId });
  await waitSent('answerCallbackQuery', { text: (t) => t.includes?.('全局开关仅可在 General') });
  assert.equal((await savedState()).notifications, true);
  assert.equal(sessions.calls.filter((c) => c.method === 'prompt').length, prompts);
  const g = await openMenu();
  click(g, '同步历史摘要');
  await waitSent('sendMessage', {
    text: (t) => t.startsWith?.('正在同步：'),
    message_thread_id: (t) => t === undefined,
  });
  const last = telegram.updateId;
  await waitUntil(async () => {
    const saved = await savedState();
    return saved.offset > last && !(saved.inbox || []).some((i) => i.id === last);
  }, 'menu sync did not finish');
});

test('output photos use multipart bytes, immutable turn references, durable retry checkpoints and silence', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const second = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('second')]).toString(
    'base64',
  );
  const s = [...sessions.list.values()][0];
  const entries = s.entries;
  s.entries = [
    ...entries,
    {
      id: 'excluded-old-image',
      role: 'assistant',
      text: 'old',
      contextBlocks: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('old')]).toString('base64'),
        },
      ],
    },
    {
      id: 'photo-one',
      role: 'assistant',
      text: 'image-one',
      contextBlocks: [{ type: 'image', mimeType: 'image/png', data: png }],
    },
    {
      id: 'photo-two',
      role: 'tool',
      tool: {
        content: [
          { type: 'content', content: { type: 'image', mimeType: 'image/png', data: second } },
        ],
      },
    },
  ];
  callback('silent:on');
  await waitUntil(async () => (await savedState()).silent === true, 'silent missing');
  const before = sent('sendPhoto').length;
  telegram.failures.push({
    match: (method, p) => method === 'sendPhoto' && p.photo.data === second,
    description: `upload ${TOKEN}`,
  });
  await publishEvent('output-photo-turn', 'output-photo-text', {
    imageEntryIds: ['photo-one', 'photo-two'],
  });
  await waitUntil(
    () => telegram.failures.length === 0 && sent('sendPhoto').length === before + 1,
    'partial photo failure missing',
  );
  await waitUntil(
    () => daemon.logs.includes('upload [redacted]'),
    'multipart error was not redacted',
  );
  assert(!daemon.logs.includes(TOKEN));
  await stopDaemon(daemon);
  daemon = startDaemon();
  await ready(daemon);
  await waitUntil(
    async () => (await savedState()).delivered.includes('output-photo-turn'),
    'photo turn not delivered after restart',
  );
  const photos = sent('sendPhoto').slice(before);
  assert.equal(photos.length, 2);
  assert.deepEqual(
    photos.map((p) => p.params.photo.data),
    [png, second],
  );
  assert(
    photos.every(
      (p) =>
        p.params.message_thread_id === state.threadId && p.params.disable_notification === true,
    ),
  );
  assert.equal(sent('sendMessage', { text: 'output-photo-text' }).length, 1);
  assert.equal(
    telegram.attempts.filter((p) => p.method === 'sendPhoto' && p.params.photo.data === second)
      .length,
    2,
  );
  assert(!daemon.logs.includes(TOKEN));
  callback('notify:off');
  await waitUntil(async () => (await savedState()).notifications === false, 'mute missing');
  await publishEvent('muted-photo-turn', 'muted-photo-text', { imageEntryIds: ['photo-one'] });
  await waitUntil(
    async () => (await savedState()).delivered.includes('muted-photo-turn'),
    'muted photo not acked',
  );
  assert.equal(sent('sendPhoto').length, before + 2);
  callback('notify:on');
  callback('silent:off');
  await waitUntil(
    async () =>
      (await savedState()).notifications === true && (await savedState()).silent === false,
    'reset toggles missing',
  );
  s.entries = entries;
});

test('recent-message sync sends local, inline and ACP images silently, skips unsafe URLs and deduplicates retries', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  await writeFile(join(workspace, 'tg-preview.png'), Buffer.from(png, 'base64'));
  const s = [...sessions.list.values()][0];
  const entries = s.entries;
  s.entries = [
    {
      id: 'history-photo',
      role: 'assistant',
      text: `![local](./tg-preview.png) ![inline](data:image/png;base64,${png}) ![remote](https://tracker.invalid/a.png) ![svg](data:image/svg+xml;base64,PHN2Zy8+)`,
      contextBlocks: [{ type: 'image', mimeType: 'image/png', data: png }],
    },
  ];
  const before = sent('sendPhoto').length;
  telegram.failures.push({ match: (method) => method === 'sendPhoto', code: 429 });
  message('/history', { thread: state.threadId });
  await waitUntil(() => sent('sendPhoto').length === before + 2, 'history photos missing');
  await waitUntil(
    async () =>
      (await savedState()).historySent[s.id].length > 0 &&
      ((await savedState()).inbox || []).length === 0,
    'history completion missing',
  );
  assert(
    sent('sendPhoto')
      .slice(before)
      .every((p) => p.params.photo.data === png && p.params.disable_notification === true),
  );
  message('/history', { thread: state.threadId });
  const last = telegram.updateId;
  await waitUntil(async () => {
    const saved = await savedState();
    return saved.offset > last && !(saved.inbox || []).some((i) => i.id === last);
  }, 'repeat history incomplete');
  await delay(100);
  assert.equal(sent('sendPhoto').length, before + 2);
  s.entries = entries;
});

test('GIF and WebP uploads use media methods and rejected photo geometry falls back to a document', async () => {
  const gif = Buffer.from('GIF89a-output').toString('base64');
  const webp = Buffer.from('RIFF1234WEBP-output').toString('base64');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');
  const s = [...sessions.list.values()][0],
    entries = s.entries;
  s.entries = [
    {
      id: 'formats',
      role: 'assistant',
      text: 'formats',
      contextBlocks: [
        { type: 'image', mimeType: 'image/gif', data: gif },
        { type: 'image', mimeType: 'image/webp', data: webp },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    },
  ];
  const animations = sent('sendAnimation').length,
    documents = sent('sendDocument').length;
  telegram.failures.push({
    match: (method, p) => method === 'sendPhoto' && p.photo.data === png,
    code: 400,
    description: 'PHOTO_INVALID_DIMENSIONS',
  });
  await publishEvent('media-formats', 'media-formats-text', { imageEntryIds: ['formats'] });
  await waitUntil(
    async () => (await savedState()).delivered.includes('media-formats'),
    'formats not delivered',
  );
  assert.equal(sent('sendAnimation').length, animations + 1);
  assert.deepEqual(
    sent('sendDocument')
      .slice(documents)
      .map((p) => p.params.document.data),
    [webp, png],
  );
  s.entries = entries;
});

test('setup uses the same ten/two preview sync and normal restarts do not sync', async () => {
  await stopDaemon(daemon);
  const s = {
    id: 'setup-sync-session',
    updated: 1e15 + 100,
    cwd: workspace,
    title: 'Setup sync',
    number: ++sessions.next,
    busy: false,
    entries: Array.from({ length: 45 }, (_, i) => ({
      id: `setup-${i}`,
      role: 'user',
      text: `setup-sync-entry-${i}`,
    })),
  };
  sessions.list.set(s.id, s);
  // Exercise the former 20-session cutoff as well as the 20-message window.
  const extra = Array.from({ length: 21 }, (_, i) => ({
    id: `setup-empty-${i}`,
    cwd: workspace,
    title: `Empty ${i}`,
    number: ++sessions.next,
    busy: false,
    entries: Array.from({ length: 15 }, (_, n) => ({
      id: `setup-extra-${i}-${n}`,
      role: 'user',
      text: `setup-extra-${i}-${n}`,
    })),
  }));
  for (const session of extra) sessions.list.set(session.id, session);
  await writeFile(configFile + '.sync-request', 'preview\n', { mode: 0o600 });
  daemon = startDaemon();
  await ready(daemon);
  await waitUntil(async () => {
    try {
      await stat(configFile + '.sync-request');
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return true;
    }
  }, 'setup sync request was not consumed');
  const saved = await savedState();
  assert.equal(saved.historySent[s.id].length, 10);
  assert(extra.every((session) => saved.historySent[session.id]?.length === 2));
  assert(extra.every((session) => saved.topics.some((topic) => topic.sessionId === session.id)));
  const output = () => sent('sendMessage', { text: (t) => t.includes?.('setup-sync-entry-') });
  assert.deepEqual(
    output().map((c) => Number(c.params.text.split('setup-sync-entry-')[1])),
    Array.from({ length: 10 }, (_, i) => i + 35),
  );
  s.entries.push({ id: 'setup-45', role: 'user', text: 'setup-sync-entry-45' });
  await stopDaemon(daemon);
  daemon = startDaemon();
  await ready(daemon);
  message('/sessions');
  await waitSent('sendMessage', { text: (t) => t.includes?.('Empty 20') });
  await waitUntil(
    async () => ((await savedState()).inbox || []).length === 0,
    'session list command was not durably completed after restart',
  );
  assert.equal(output().length, 10, 'normal restart must not auto-sync new history');
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
    ).catch((error) => {
      error.message += `\nlogs: ${daemon.logs}\noffset: ${before.offset}; updateId: ${telegram.updateId}\nlast polls: ${JSON.stringify(telegram.attempts.filter((a) => a.method === 'getUpdates').slice(-5))}`;
      throw error;
    });
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
