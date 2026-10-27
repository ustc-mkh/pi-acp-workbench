import {
  archivedEntry,
  imageArchive,
  contentText,
  deliveryRecords,
  deliveryEntryIds,
  assertStorageLayout,
} from './lib/workbench-sqlite-fixture.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  mkdir,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkbenchWire, turnFinished, inlineText } from '../test/helpers/workbench-wire.mjs';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);

const root = await mkdtemp(join(tmpdir(), 'workbench-tg-contract-'));
const data = join(root, 'data');
const traceFile = join(root, 'agent-trace.ndjson');
const configGate = join(root, 'provider-gate');
const configFile = join(root, 'config.json');
const socket = join(data, 'workbench.sock');
const token = '123:FAKE_CONTRACT_SECRET';
const agent = resolve('test/contract-agent.mjs');
const children = new Set();
const updates = [];
const sent = [];
const mediaSent = [];
const sendOrder = [];
let mediaRateLimit = false;
let mediaRateFailures = 0;
let holdMedia = false;
let mediaHolds = 0;
let mediaClosed = 0;
let releaseMedia;
let nextUpdate = 1;
let topics = 0;
const topicNames = [];
const topicTitleEdits = [];
let acknowledgements = 0;
let rateLimit = false;
let rateFailures = 0;
let fatalPoll = false;
let checks = 0;
const edits = [];
let client;
const check = (text) => {
  console.log(`ok   ${text}`);
  checks++;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(
    `timeout: ${description}; recent fixture replies=${JSON.stringify(sent.slice(-6).map((message) => ({ thread: message.message_thread_id, text: message.text.slice(0, 180) })))}`,
  );
}
function message(id, thread, text, sender = 5, chat = -100) {
  return {
    message_id: id,
    chat: { id: chat, is_forum: true },
    message_thread_id: thread,
    from: { id: sender, is_bot: false },
    text,
  };
}
function text(text, thread, sender = 5, chat = -100) {
  const id = nextUpdate++;
  updates.push({ update_id: id, message: message(id, thread, text, sender, chat) });
  return id;
}
function callback(key, thread, sender = 5) {
  const id = nextUpdate++;
  updates.push({
    update_id: id,
    callback_query: {
      id: `q-${id}`,
      from: { id: sender, is_bot: false },
      message: message(id, thread),
      data: key,
    },
  });
  return id;
}
function multipart(raw, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  assert(boundary, 'multipart boundary');
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const fields = {};
  let offset = 0;
  while (true) {
    const start = raw.indexOf(marker, offset);
    if (
      start < 0 ||
      raw.subarray(start + marker.length, start + marker.length + 2).toString() === '--'
    )
      break;
    const end = raw.indexOf(marker, start + marker.length);
    assert(end > start);
    const part = raw.subarray(start + marker.length + 2, end - 2);
    const split = part.indexOf('\r\n\r\n');
    assert(split > 0);
    const header = part.subarray(0, split).toString();
    const name = /name="([^"]+)"/.exec(header)[1];
    const filename = /filename="([^"]+)"/.exec(header)?.[1];
    const bytes = part.subarray(split + 4);
    fields[name] = filename ? { filename, bytes, header } : bytes.toString();
    offset = end;
  }
  return fields;
}
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] || '';
  const body = contentType.startsWith('multipart/form-data')
    ? multipart(raw, contentType)
    : JSON.parse(raw.toString() || '{}');
  const method = request.url.split('/').at(-1);
  let result;
  let error;
  if (method === 'getMe') result = { id: 999, is_bot: true, username: 'fixture_bot' };
  else if (method === 'getChat') result = { id: body.chat_id, is_forum: true };
  else if (method === 'editForumTopic') {
    topicTitleEdits.push(body);
    result = true;
  } else if (method === 'getUpdates') {
    assert.deepEqual(body.allowed_updates, ['message', 'callback_query']);
    if (fatalPoll) error = { error_code: 401, description: `DO NOT LOG ${token}` };
    else result = updates.filter((update) => update.update_id >= body.offset);
  } else if (method === 'createForumTopic') {
    topicNames.push(body.name);
    result = { message_thread_id: 100 + 1000 * ++topics };
  } else if (method === 'deleteMessage') {
    result = true;
  } else if (method === 'sendMessage') {
    if (rateLimit) {
      rateLimit = false;
      rateFailures++;
      error = { error_code: 429, parameters: { retry_after: 1 } };
    } else {
      assert(body.text.length > 0);
      assert([...body.text].reduce((size, character) => size + character.length, 0) <= 4096);
      sent.push(body);
      sendOrder.push(`text:${body.text}`);
      result = message(sent.length, body.message_thread_id, body.text, 999, body.chat_id);
    }
  } else if (method === 'editMessageText') {
    const original = sent[body.message_id - 1];
    assert(original && original.chat_id === body.chat_id);
    assert(body.text.length <= 4096);
    edits.push(body);
    original.text = body.text;
    result = message(body.message_id, original.message_thread_id, body.text, 999, body.chat_id);
  } else if (['sendPhoto', 'sendAnimation', 'sendDocument'].includes(method)) {
    const field = { sendPhoto: 'photo', sendAnimation: 'animation', sendDocument: 'document' }[
      method
    ];
    assert(Buffer.isBuffer(body[field]?.bytes));
    if (mediaRateLimit) {
      mediaRateLimit = false;
      mediaRateFailures++;
      error = { error_code: 429, parameters: { retry_after: 1 } };
    } else {
      if (holdMedia) {
        holdMedia = false;
        mediaHolds++;
        const accepted = await new Promise((resolve) => {
          releaseMedia = () => resolve(true);
          response.once('close', () => {
            if (!response.writableEnded) {
              mediaClosed++;
              resolve(false);
            }
          });
        });
        releaseMedia = undefined;
        if (!accepted) return;
      }
      mediaSent.push({
        method,
        field,
        file: body[field],
        chat: Number(body.chat_id),
        thread: Number(body.message_thread_id),
        silent: body.disable_notification === 'true',
      });
      sendOrder.push('image');
      result = message(
        1000 + mediaSent.length,
        Number(body.message_thread_id),
        undefined,
        999,
        Number(body.chat_id),
      );
    }
  } else if (method === 'answerCallbackQuery') {
    acknowledgements++;
    result = true;
  } else {
    response.writeHead(500);
    response.end('{}');
    return;
  }
  response.writeHead(error?.error_code || 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(error ? { ok: false, ...error } : { ok: true, result }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = {
  workers: {
    pi: {
      command: process.execPath,
      args: [agent],
      env: { WORKBENCH_CONTRACT_TRACE: traceFile, WORKBENCH_CONTRACT_CONFIG_GATE: configGate },
    },
  },
  sessions: { mailbox: 128, max_workers: 16 },
  telegram: {
    bot_token_env: 'REWRITE_TEST_BOT_TOKEN',
    workspace: root,
    allowed_chat_ids: [-100],
    allowed_user_ids: [5],
    api_base: `http://127.0.0.1:${server.address().port}/`,
    inbox_capacity: 128,
  },
  storage: { root: data },
  limits: { pending_interactions: 32 },
};
function launch() {
  const child = spawn(binary, ['--config', configFile], {
    env: { ...process.env, REWRITE_TEST_BOT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (data) => (child.output += data));
  child.stderr.on('data', (data) => (child.output += data));
  child.done = new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  children.add(child);
  return child;
}
async function start() {
  const child = launch();
  await until(() => {
    if (child.exitCode !== null) throw new Error('daemon exited before readiness');
    return child.output.includes('ready:');
  }, 'daemon readiness');
  client = await WorkbenchWire.open(socket);
  return child;
}
async function stop(child) {
  client?.close();
  client = undefined;
  child.kill('SIGTERM');
  assert.equal(await child.done, 0);
  assertStorageLayout(data);
  assert(!child.output.includes(token), 'bot token must never appear in daemon output');
}
async function rateLimitedPending() {
  return deliveryRecords(data).some(
    (body) => body.status === 'Pending' && body.last_failure === 'RateLimited',
  );
}
async function trace() {
  try {
    return (await readFile(traceFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
try {
  await writeFile(configFile, JSON.stringify(config));
  let daemon = await start();
  text('/new');
  await until(
    async () => (await client.call({ method: 'list' })).sessions.length === 1 && sent.length > 0,
    'forum session creation',
  );
  const session = (await client.call({ method: 'list' })).sessions[0].id;
  const thread = sent[0].message_thread_id;
  assert.equal(topics, 1);
  assert(thread);
  await client.call({ method: 'attach', session });
  check('one host creates forum topic and session through its shared runtime');
  let finished = client.waitFor((batch) => turnFinished(batch, session));
  text('你好', thread);
  await finished;
  await until(() => sent.some((message) => message.text === 'echo: 你好'), 'Telegram agent output');
  check('Telegram prompt produces IPC events and durable Telegram output');
  const interaction = client.waitFor(
    (batch) =>
      batch.session === session && Object.keys(batch.view?.pending_interactions || {}).length,
  );
  await client.call(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'permission' }] } },
    'contract-permission',
  );
  const requested = Object.keys((await interaction).view.pending_interactions)[0];
  await until(() => sent.some((message) => message.reply_markup), 'permission keyboard');
  const key = sent.find((message) => message.reply_markup).reply_markup.inline_keyboard[0][0]
    .callback_data;
  callback(key, thread + 1);
  callback(key, thread, 6);
  await until(() => acknowledgements >= 2, 'rejected callback acknowledgement');
  const waiting = await client.call({ method: 'inspect', session });
  assert(waiting.pending_interactions[requested]);
  finished = client.waitFor((batch) => turnFinished(batch, session));
  callback(key, thread);
  await finished;
  assert.deepEqual((await client.call({ method: 'inspect', session })).pending_interactions, {});
  check(
    'IPC permission → Telegram UI → typed response; wrong-topic/unauthorized callbacks cannot consume it',
  );
  await until(
    () => sent.some((message) => message.text.startsWith('✅ 任务完成')),
    'permission completion delivery',
  );
  rateLimit = true;
  finished = client.waitFor((batch) => turnFinished(batch, session));
  text('retry-output', thread);
  await finished;
  await until(() => rateFailures === 1, 'rate-limited send');
  await until(rateLimitedPending, 'persisted retry metadata');
  const nativeBeforeRestart = (await client.call({ method: 'inspect', session })).provider_session;
  await stop(daemon);
  daemon = await start();
  await client.call({ method: 'attach', session });
  const nativeResumed = client.waitFor((batch) => turnFinished(batch, session));
  text('telegram native resume', thread);
  await nativeResumed;
  assert.equal(
    (await client.call({ method: 'inspect', session })).provider_session,
    nativeBeforeRestart,
  );
  check(
    'a bound Telegram prompt explicitly loads its cold actor and resumes the native session after restart',
  );
  await until(
    () => sent.some((message) => message.text === 'echo: retry-output'),
    'retry after restart',
  );
  await until(
    () => sent.some((message) => message.text === 'echo: telegram native resume'),
    'earlier resumed output settled',
  );
  assert.equal((await trace()).filter((record) => record.text === 'retry-output').length, 1);
  assert.equal(topics, 1);
  assert.equal((await client.call({ method: 'list' })).sessions.length, 1);
  check(
    '429 retry metadata survives restart without rerunning the agent or duplicating topic/session',
  );
  mediaRateLimit = true;
  const imageOrderStart = sendOrder.length;
  finished = client.waitFor((batch) => turnFinished(batch, session));
  text('image-output', thread);
  await finished;
  await until(() => mediaRateFailures === 1, 'rate-limited multipart image');
  await until(rateLimitedPending, 'persisted image retry');
  text('/help', thread);
  let laterNotice;
  await until(async () => {
    for (const body of deliveryRecords(data)) {
      if (body.status === 'Pending' && body.event.target.Telegram && body.event.payload.Notice) {
        laterNotice = contentText(data, body.event.payload.Notice.content);
        return true;
      }
    }
    return false;
  }, 'later same-topic control notice durably admitted behind image retry');
  assert(
    !sent.some((message) => message.text === laterNotice),
    'later notice must not bypass deferred image',
  );
  await stop(daemon);
  daemon = await start();
  await client.call({ method: 'attach', session });
  await until(
    () => mediaSent.length === 1 && sent.some((message) => message.text === 'image caption'),
    'archived image retry after restart',
  );
  const imageRow = (await client.call({ method: 'history', session })).entries.find(
    (entry) => entry.image,
  );
  const imageRecord = imageArchive(data, imageRow.image.id);
  assert.deepEqual(mediaSent[0].file.bytes, Buffer.from(imageRecord.data, 'base64'));
  assert.equal(mediaSent[0].thread, thread);
  assert.equal(mediaSent[0].chat, -100);
  assert.equal(mediaSent[0].method, 'sendPhoto');
  assert.equal(mediaSent[0].file.filename, `${imageRow.image.id}.png`);
  await until(
    () => sent.some((message) => message.text.includes(laterNotice.slice(0, 24))),
    'later notice follows image after restart',
  );
  const laterSent = sent.find((message) => message.text.includes(laterNotice.slice(0, 24)));
  assert(laterSent);
  assert.deepEqual(sendOrder.slice(imageOrderStart), [
    'text:你（VS Code）：\nimage-output',
    'image',
    'text:image caption',
    'text:✅ 任务完成',
    `text:${laterSent.text}`,
  ]);
  assert.equal((await trace()).filter((record) => record.text === 'image-output').length, 1);
  check(
    'multipart image retry survives restart, preserves archived bytes/topic/order and never reruns the agent',
  );
  check(
    'a later same-topic control notice cannot overtake a deferred image, including across restart',
  );
  await client.call({ method: 'load', session });
  const envText = client.waitFor((batch) =>
    batch.entries.some((entry) => inlineText(entry) === 'bot-env-hidden'),
  );
  finished = client.waitFor((batch) => turnFinished(batch, session));
  await client.call({
    method: 'prompt',
    session,
    prompt: { parts: [{ type: 'text', text: 'check-bot-env' }] },
  });
  await envText;
  await finished;
  check('actual ACP child cannot inherit the bot token environment variable');
  finished = client.waitFor((batch) => turnFinished(batch, session));
  text('plan-report', thread);
  await finished;
  await delay(250);
  assert(!sent.some((message) => message.text.includes('Plan:')));
  text('/status', thread);
  await until(
    () => sent.some((message) => message.text.includes('Plan:')),
    'explicit status projection',
  );
  check('Todo is rendered only by explicit /status, never as a live notification');
  text('/model other', thread);
  await until(
    () => stat(`${configGate}.started`).catch(() => null),
    'blocked Telegram provider setting',
  );
  let otherThread = thread + 1;
  text('/new', otherThread);
  await until(
    async () => (await client.call({ method: 'list' })).sessions.length === 2,
    'independent topic creation',
  );
  const otherSession = (await client.call({ method: 'list' })).sessions.find(
    (entry) => entry.id !== session,
  ).id;
  await until(
    () => sent.some((message) => message.text.startsWith(`Session ${otherSession}`)),
    'independent topic binding',
  );
  otherThread = sent.find((m) => m.text.startsWith(`Session ${otherSession}`)).message_thread_id;
  await client.call({ method: 'attach', session: otherSession });
  const independent = client.waitFor((batch) => turnFinished(batch, otherSession));
  text('independent-while-config-blocked', otherThread);
  await independent;
  const statusStart = sent.length;
  text('/status', thread);
  await until(
    () =>
      sent
        .slice(statusStart)
        .some((message) => message.message_thread_id === thread && message.text.includes('Plan:')),
    'query bypasses blocked topic mutation',
  );
  assert((await client.call({ method: 'inspect', session })).configuration_intent);
  check(
    'a blocked Telegram provider leaves other topics, IPC and same-topic status queries responsive',
  );
  await writeFile(`${configGate}.release`, 'release');
  await until(async () => {
    const state = await client.call({ method: 'inspect', session });
    return state.config.model === 'other' && !state.configuration_intent;
  }, 'Telegram setting completion');
  holdMedia = true;
  const mediaStart = sent.length;
  finished = client.waitFor((batch) => turnFinished(batch, session));
  text('image-output', thread);
  await finished;
  await until(() => mediaHolds === 1, 'in-flight multipart HTTP hold');
  text('/help', thread);
  const mediaIndependent = client.waitFor((batch) => turnFinished(batch, otherSession));
  text('independent-while-media-blocked', otherThread);
  await mediaIndependent;
  await until(
    () =>
      sent
        .slice(mediaStart)
        .some(
          (message) =>
            message.message_thread_id === otherThread &&
            message.text === 'echo: independent-while-media-blocked',
        ),
    'other topic output while media HTTP is in-flight',
  );
  assert(
    !sent
      .slice(mediaStart)
      .some(
        (message) =>
          message.message_thread_id === thread &&
          [laterNotice, 'image caption'].includes(message.text),
      ),
  );
  releaseMedia();
  await until(
    () =>
      sent
        .slice(mediaStart)
        .some(
          (message) =>
            message.message_thread_id === thread && message.text.includes(laterNotice.slice(0, 24)),
        ),
    'same-topic notice after held upload completes',
  );
  const heldOrder = sent
    .slice(mediaStart)
    .filter(
      (message) =>
        message.message_thread_id === thread &&
        [laterNotice, 'image caption'].some(
          (text) => text && message.text.includes(text.slice(0, 24)),
        ),
    )
    .map((message) => message.text);
  assert.equal(heldOrder[0], 'image caption');
  assert(heldOrder[1].includes(laterNotice.slice(0, 24)));
  check(
    'an in-flight image HTTP request does not block another topic, while later same-topic output remains FIFO',
  );
  const traceStart = (await trace()).length;
  const cancelInteraction = client.waitFor(
    (batch) =>
      batch.session === session && Object.keys(batch.view?.pending_interactions || {}).length,
  );
  await client.call({
    method: 'prompt',
    session,
    prompt: { parts: [{ type: 'text', text: 'permission' }] },
  });
  await cancelInteraction;
  const cancelled = await client.call({ method: 'cancel', session });
  assert(cancelled.Accepted);
  await until(async () => {
    const records = (await trace()).slice(traceStart);
    return (
      records.some((record) => record.method === 'session/cancel') &&
      records.some((record) => record.method === 'agent-response' && record.outcome === 'cancelled')
    );
  }, 'flushed ACP cancel and cancelled interaction response');
  check(
    'host cancel flushes ACP cancellation and interaction replies before terminating the worker',
  );
  // Let the cancelled source restore its model while the global fixture gate
  // is still released; then independently block the other topic's setting.
  holdMedia = true;
  finished = client.waitFor((batch) => turnFinished(batch, session));
  text('image-output', thread);
  await finished;
  await until(() => mediaHolds === 2, 'in-flight image before fatal cleanup');
  await rm(`${configGate}.release`);
  await rm(`${configGate}.started`);
  text('/model other', otherThread);
  await until(
    () => stat(`${configGate}.started`).catch(() => null),
    'blocked record before fatal polling',
  );
  await client.call({ method: 'remove', session }, 'remove-source-with-pending-image');
  assert(!(await client.call({ method: 'list' })).sessions.some((entry) => entry.id === session));
  fatalPoll = true;
  await until(
    () => daemon.exitCode !== null,
    'fatal cleanup with a blocked Telegram record and image HTTP',
  );
  await until(() => mediaClosed === 1, 'cancelled image HTTP socket closed');
  let pendingImage;
  for (const body of deliveryRecords(data)) {
    if (body.status !== 'Pending' || !body.event.payload.Turn) continue;
    for (const entry of deliveryEntryIds(data, body.event.id)) {
      const archived = archivedEntry(data, entry);
      if (archived.image) pendingImage = archived.image;
    }
  }
  assert(pendingImage, 'cancelled HTTP must retain the archived image intent Pending');
  check(
    'fatal shutdown cancels in-flight media HTTP, closes its socket and retains its immutable Pending image intent',
  );
  assert.notEqual(await daemon.done, 0);
  client.close();
  client = undefined;
  await assert.rejects(stat(socket), { code: 'ENOENT' });
  assert(!daemon.output.includes(token), 'fatal API errors must not leak request URLs/tokens');
  for (const record of (await trace()).filter((record) => record.method === 'boot')) {
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
  }
  check(
    'fatal Telegram polling drains blocked execution, joins workers, closes IPC and reports failure without credential leakage',
  );
  const peersBeforeDeletedRetry = await trace();
  const mediaBeforeDeletedRetry = mediaSent.length;
  fatalPoll = false;
  daemon = await start();
  await until(
    () =>
      mediaSent.length === mediaBeforeDeletedRetry + 1 &&
      sent.filter(
        (message) => message.message_thread_id === thread && message.text === 'image caption',
      ).length === 3,
    'archived image delivery after source deletion and restart',
  );
  const deletedMedia = mediaSent.at(-1);
  const deletedAsset = imageArchive(data, pendingImage.id);
  assert.deepEqual(deletedMedia.file.bytes, Buffer.from(deletedAsset.data, 'base64'));
  assert.equal(deletedMedia.file.filename, `${pendingImage.id}.png`);
  assert.equal(deletedMedia.thread, thread);
  assert.deepEqual(
    await trace(),
    peersBeforeDeletedRetry,
    'delivery after source deletion/restart must not spawn or rerun ACP',
  );
  assert(!(await client.call({ method: 'list' })).sessions.some((entry) => entry.id === session));
  check(
    'frozen workspace scope authorizes the original bound topic after external source deletion and restart, without ACP or different bytes',
  );
  // The fatal-cleanup barrier is finished. New sessions now inherit the last
  // successfully observed model, so leaving this global synthetic gate closed
  // would block their first configure (not image delivery). Do not relax the
  // revision timeout or silently rerun the failing image case.
  await writeFile(`${configGate}.release`, 'fatal-cleanup barrier finished');
  // Independent topic: preferences are useful before a session even exists.
  // Keep this after the source-removal oracle so its image counts stay independent.
  let preferenceThread = thread + 2;
  const coldBefore = (await trace()).filter((record) =>
    ['boot', 'session/prompt'].includes(record.method),
  );
  text('/notifications off', preferenceThread);
  text('/silent on', preferenceThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === preferenceThread && message.text.startsWith('Silent: on'),
      ),
    'durable topic settings confirmation',
  );
  await stop(daemon);
  daemon = await start();
  text('/notifications', preferenceThread);
  await until(
    () =>
      sent.filter(
        (message) =>
          message.message_thread_id === preferenceThread &&
          message.text.startsWith('Notifications: off'),
      ).length === 2,
    'topic preference restored after real daemon restart',
  );
  assert.deepEqual(
    (await trace()).filter((record) => ['boot', 'session/prompt'].includes(record.method)),
    coldBefore,
  );
  assert(
    sent
      .filter(
        (message) =>
          message.message_thread_id === preferenceThread &&
          message.text.startsWith('Notifications: off'),
      )
      .at(-1).disable_notification,
  );
  check(
    'topic notification/silent preferences survive real restart, remain cold and return silent explicit query replies',
  );
  const beforeCreate = new Set(
    (await client.call({ method: 'list' })).sessions.map((entry) => entry.id),
  );
  text('/new', preferenceThread);
  let preferenceSession;
  await until(async () => {
    preferenceSession = (await client.call({ method: 'list' })).sessions.find(
      (entry) => !beforeCreate.has(entry.id),
    )?.id;
    return (
      preferenceSession &&
      sent.some((message) => message.text.startsWith(`Session ${preferenceSession}`))
    );
  }, 'new session gets its own topic');
  preferenceThread = sent.find((m) =>
    m.text.startsWith(`Session ${preferenceSession}`),
  ).message_thread_id;
  text('/notifications off', preferenceThread);
  text('/silent on', preferenceThread);
  await until(
    () =>
      sent.some((m) => m.message_thread_id === preferenceThread && m.text.startsWith('Silent: on')),
    'independent new topic preferences',
  );
  await client.call({ method: 'attach', session: preferenceSession });
  assert.equal(
    (await client.call({ method: 'inspect', session: preferenceSession })).config.model,
    'other',
    'new session inherits the successful setting and needs the released configure barrier',
  );
  const mutedPromptCount = (await trace()).filter(
    (record) => record.text === 'image-output',
  ).length;
  const mutedMedia = mediaSent.length;
  const mutedMessages = sent.length;
  finished = client.waitFor((batch) => turnFinished(batch, preferenceSession));
  text('image-output', preferenceThread);
  await finished;
  await until(
    () =>
      deliveryRecords(data).some(
        (record) =>
          record.event.payload.Turn?.session === preferenceSession && record.status === 'Acked',
      ),
    'muted automatic intent settled without HTTP',
  );
  assert.equal(mediaSent.length, mutedMedia);
  assert(
    !sent
      .slice(mutedMessages)
      .some(
        (message) =>
          message.message_thread_id === preferenceThread && message.text === 'image caption',
      ),
  );
  assert.equal(
    (await trace()).filter((record) => record.text === 'image-output').length,
    mutedPromptCount + 1,
  );
  assert(
    (await client.call({ method: 'history', session: preferenceSession })).entries.some(
      (entry) => entry.image,
    ),
  );
  text('/history', preferenceThread);
  await until(
    () =>
      sent
        .slice(mutedMessages)
        .some(
          (message) =>
            message.message_thread_id === preferenceThread &&
            message.text.includes('image caption'),
        ),
    'explicit history while automatic notifications are off',
  );
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === preferenceThread &&
          message.text.startsWith(`History export · session ${preferenceSession}`),
      ),
    'explicit history images and summary complete',
  );
  const historyMedia = mediaSent.length;
  assert.equal(historyMedia, mutedMedia + 1, 'explicit history exports the muted archived image');
  check(
    'notifications off skips successful text/image HTTP only; the Agent runs once and explicit cold history remains available',
  );
  text('/notifications on', preferenceThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === preferenceThread &&
          message.text.startsWith('Notifications: on'),
      ),
    're-enable notifications',
  );
  assert.equal(mediaSent.length, historyMedia, 're-enable must not replay skipped images');
  finished = client.waitFor((batch) => turnFinished(batch, preferenceSession));
  text('image-output', preferenceThread);
  await finished;
  await until(
    () =>
      mediaSent.length === historyMedia + 1 &&
      sent.some(
        (message) =>
          message.message_thread_id === preferenceThread && message.text === 'image caption',
      ),
    'silent text and media through the actual Bot HTTP boundary',
  );
  assert(mediaSent.at(-1).silent);
  assert(
    sent
      .filter(
        (message) =>
          message.message_thread_id === preferenceThread && message.text === 'image caption',
      )
      .at(-1).disable_notification,
  );
  assert.equal(
    (await trace()).filter((record) => record.text === 'image-output').length,
    mutedPromptCount + 2,
  );
  check(
    'silent uses disable_notification for real JSON text and binary multipart media, without hiding output or replaying skipped results',
  );
  // Opening another topic's bound session is intentionally not a binding
  // transfer. Use an older unbound session as the paginated-open oracle.
  const menuTargetSummary = (await client.call({ method: 'create', harness: 'Pi', cwd: root }))
    .Created.summary;
  const menuTarget = menuTargetSummary.id;
  let menuThread = preferenceThread + 1;
  const menuButtons = (heading) =>
    sent
      .findLast(
        (message) =>
          message.message_thread_id === menuThread &&
          message.text.startsWith(heading) &&
          message.reply_markup,
      )
      ?.reply_markup.inline_keyboard.flat();
  text('/menu', menuThread);
  await until(() => menuButtons('Workbench menu'), 'interactive menu keyboard');
  const newButton = menuButtons('Workbench menu').find((button) => button.text === 'New Pi');
  assert(newButton);
  assert(
    !menuButtons('Workbench menu').some((button) =>
      ['New Codex', 'New Claude'].includes(button.text),
    ),
  );
  const beforeMenu = new Set(
    (await client.call({ method: 'list' })).sessions.map((entry) => entry.id),
  );
  const menuAcks = acknowledgements;
  callback(newButton.callback_data, menuThread + 1);
  callback(newButton.callback_data, menuThread, 6);
  await until(
    () => acknowledgements >= menuAcks + 2,
    'wrong-topic/unauthorized menu acknowledgement',
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, beforeMenu.size);
  await stop(daemon);
  daemon = await start();
  callback(newButton.callback_data, menuThread);
  let menuSession;
  await until(async () => {
    menuSession = (await client.call({ method: 'list' })).sessions.find(
      (entry) => !beforeMenu.has(entry.id),
    )?.id;
    return menuSession && sent.some((message) => message.text.startsWith(`Session ${menuSession}`));
  }, 'persisted menu create callback after restart');
  const usedStart = sent.length;
  callback(newButton.callback_data, menuThread);
  await until(
    () =>
      sent
        .slice(usedStart)
        .some(
          (message) =>
            message.message_thread_id === menuThread && message.text.includes('按钮已使用'),
        ),
    'single-use menu callback refusal',
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, beforeMenu.size + 1);
  assert.equal(
    (await client.call({ method: 'inspect', session: menuSession })).provider_session,
    null,
  );
  check(
    'interactive configured-harness menu survives restart; wrong-topic/unauthorized/double clicks cannot create extra sessions',
  );
  menuThread = sent.find((m) => m.text.startsWith(`Session ${menuSession}`)).message_thread_id;
  const preferenceNumber = menuTargetSummary.created_seq;
  for (let i = 0; i < 12; i++) await client.call({ method: 'create', harness: 'Pi', cwd: root });
  text('/menu sessions', menuThread);
  await until(() => menuButtons('Open session'), 'bounded session menu');
  let open;
  let pages = 0;
  while (!open && pages++ < 5) {
    const buttons = menuButtons('Open session');
    assert(buttons.filter((button) => button.text.startsWith('#')).length <= 10);
    open = buttons.find((button) => button.text.startsWith(`#${preferenceNumber} `));
    if (open) break;
    const next = buttons.find((button) => button.text === 'Next session page');
    assert(next, 'requested session remains reachable through menu pages');
    const count = sent.filter(
      (message) =>
        message.message_thread_id === menuThread && message.text.startsWith('Open session'),
    ).length;
    callback(next.callback_data, menuThread);
    await until(
      () =>
        sent.filter(
          (message) =>
            message.message_thread_id === menuThread && message.text.startsWith('Open session'),
        ).length > count,
      'next bounded menu page',
    );
  }
  assert(open);
  assert(pages > 1, 'contract must actually cross a menu page boundary');
  // Opening a native session may explicitly restore its saved settings. The
  // earlier fault-injection gate must not block this unrelated menu workflow.
  await writeFile(`${configGate}.release`, 'release');
  const openUpdate = callback(open.callback_data, menuThread);
  const openReplyStart = sent.length;
  await until(async () => {
    if (
      sent
        .slice(openReplyStart)
        .some(
          (message) =>
            message.message_thread_id === menuThread && message.text.startsWith('操作失败'),
        )
    ) {
      const result = await client.call({
        method: 'operation',
        operation: `telegram-update-${openUpdate}`,
      });
      throw new Error(`menu open failed: ${JSON.stringify(result)}`);
    }
    return sent.some((message) => message.text === `Attached session ${menuTarget}`);
  }, 'menu opens the selected cold session');
  menuThread = sent.findLast((m) => m.text === `Attached session ${menuTarget}`).message_thread_id;
  check(
    'mobile session menu traverses bounded keyset pages and opens the exact selected existing session through the shared command path',
  );
  // Menus are cold catalogue queries: opening a never-run session must not
  // implicitly start a provider just to populate a keyboard.
  text('menu prime', menuThread);
  await until(async () => {
    const view = await client.call({ method: 'inspect', session: menuTarget });
    return (
      view.provider_session &&
      view.active_turn === null &&
      sent.some(
        (message) =>
          message.message_thread_id === menuThread && message.text.includes('echo: menu prime'),
      )
    );
  }, 'explicit prompt populates committed provider offerings');
  text('/menu models', menuThread);
  await until(() => menuButtons('Models'), 'provider model menu');
  const otherModel = menuButtons('Models').find((button) => button.text === 'Other');
  assert(otherModel, 'only the actual committed provider offering can be selected');
  callback(otherModel.callback_data, menuThread);
  await until(
    async () =>
      (await client.call({ method: 'inspect', session: menuTarget })).config.model === 'other',
    'menu model setting',
  );
  text('/menu modes', menuThread);
  await until(() => menuButtons('Modes'), 'provider mode menu');
  const highMode = menuButtons('Modes').find((button) => button.text === 'Thinking: high');
  assert(highMode);
  callback(highMode.callback_data, menuThread);
  await until(
    async () =>
      (await client.call({ method: 'inspect', session: menuTarget })).config.mode === 'high',
    'menu mode setting',
  );
  const newHome = sent.filter(
    (message) =>
      message.message_thread_id === menuThread && message.text.startsWith('Workbench menu'),
  ).length;
  text('/menu', menuThread);
  await until(
    () =>
      sent.filter(
        (message) =>
          message.message_thread_id === menuThread && message.text.startsWith('Workbench menu'),
      ).length > newHome,
    'fresh bound menu',
  );
  const staleStop = menuButtons('Workbench menu').find(
    (button) => button.text === 'Stop current turn',
  );
  assert(staleStop);
  text(`/open ${menuSession}`, menuThread);
  await until(
    () => sent.some((message) => message.text === `Attached session ${menuSession}`),
    'open redirects to the existing topic without stealing bindings',
  );
  text('/remove', menuThread);
  await until(
    async () => !(await client.call({ method: 'list' })).sessions.some((s) => s.id === menuTarget),
    'remove invalidates old topic controls',
  );
  const rejectedStart = sent.length;
  const staleTrace = await trace();
  callback(staleStop.callback_data, menuThread);
  await until(
    () =>
      sent
        .slice(rejectedStart)
        .some(
          (message) =>
            message.message_thread_id === menuThread && message.text.includes('按钮无效'),
        ),
    'stale menu refusal after topic rebind',
  );
  assert.deepEqual(
    await trace(),
    staleTrace,
    'a stale menu must not cancel/configure a different bound task',
  );
  check(
    'provider-offered model/mode menu buttons execute real configuration; opening keeps bindings and removal invalidates old controls before Agent effects',
  );
  const directoryRoot = join(root, 'directory-fixture');
  for (let index = 0; index < 13; index++)
    await mkdir(join(directoryRoot, `d${String(index).padStart(2, '0')}`), { recursive: true });
  const chosenDirectory = join(directoryRoot, 'd12', '项目 😀');
  await mkdir(chosenDirectory);
  await mkdir(join(directoryRoot, '.private'));
  await symlink(tmpdir(), join(directoryRoot, 'external-link'));
  await symlink(join(directoryRoot, 'd12'), join(directoryRoot, 'internal-link'));
  await writeFile(join(directoryRoot, 'binary-file'), Buffer.from([0xff, 0xfe]));
  let directoryThread = menuThread + 2;
  const directoryReplies = (heading) =>
    sent.filter(
      (message) =>
        message.message_thread_id === directoryThread && message.text.startsWith(heading),
    );
  const directoryButtons = (heading = 'Choose directory') =>
    directoryReplies(heading)
      .findLast((message) => message.reply_markup)
      ?.reply_markup.inline_keyboard.flat();
  const directoryClick = async (
    label,
    heading = 'Choose directory',
    source = 'Choose directory',
  ) => {
    const button = directoryButtons(source)?.find((button) => button.text === label);
    assert(button, `directory workflow has ${label}`);
    const count = directoryReplies(heading).length;
    callback(button.callback_data, directoryThread);
    await until(() => directoryReplies(heading).length > count, `directory menu ${label}`);
  };
  text('/menu', directoryThread);
  await until(() => directoryButtons('Workbench menu'), 'directory workflow home');
  await directoryClick('Browse directories', 'Choose directory', 'Workbench menu');
  await directoryClick('Directory: directory-fixture');
  assert.equal(
    directoryButtons().filter((button) => button.text.startsWith('Directory:')).length,
    10,
  );
  assert(!directoryButtons().some((button) => /private|link|binary/.test(button.text)));
  await directoryClick('Next directories');
  assert.equal(
    directoryButtons().filter((button) => button.text.startsWith('Directory:')).length,
    3,
  );
  await directoryClick('Directory: d12');
  await directoryClick('Directory: 项目 😀');
  await directoryClick('Use this directory', 'Choose harness');
  assert(
    !directoryButtons('Choose harness').some((button) =>
      ['New Codex', 'New Claude'].includes(button.text),
    ),
  );
  const directoryNew = directoryButtons('Choose harness').find(
    (button) => button.text === 'New Pi',
  );
  assert(directoryNew);
  const beforeDirectory = new Set(
    (await client.call({ method: 'list' })).sessions.map((entry) => entry.id),
  );
  await stop(daemon);
  daemon = await start();
  const directoryBoots = (await trace()).filter((record) => record.method === 'boot').length;
  callback(directoryNew.callback_data, directoryThread);
  let directorySession;
  await until(async () => {
    directorySession = (await client.call({ method: 'list' })).sessions.find(
      (entry) => !beforeDirectory.has(entry.id),
    )?.id;
    return (
      directorySession &&
      sent.some((message) => message.text.startsWith(`Session ${directorySession}`))
    );
  }, 'selected directory callback creates after restart');
  const directoryView = await client.call({ method: 'inspect', session: directorySession });
  assert.equal(directoryView.cwd, chosenDirectory);
  assert.equal(directoryView.provider_session, null);
  const directoryUsed = sent.length;
  callback(directoryNew.callback_data, directoryThread);
  await until(
    () =>
      sent
        .slice(directoryUsed)
        .some(
          (message) =>
            message.message_thread_id === directoryThread && message.text.includes('按钮已使用'),
        ),
    'directory duplicate callback refusal',
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, beforeDirectory.size + 1);
  assert.equal((await trace()).filter((record) => record.method === 'boot').length, directoryBoots);
  check(
    'mobile directory menu traverses bounded pages, omits symlinks/hidden/files, selects configured harness and creates exact Unicode cwd once after restart without ACP',
  );
  directoryThread += 1;
  text('/menu directories', directoryThread);
  await until(() => directoryButtons(), 'fresh directory command entry');
  await directoryClick('Directory: directory-fixture');
  await directoryClick('Next directories');
  await directoryClick('Directory: d12');
  await directoryClick('Directory: 项目 😀');
  await directoryClick('Use this directory', 'Choose harness');
  const guardedNew = directoryButtons('Choose harness').find((button) => button.text === 'New Pi');
  assert(guardedNew);
  const savedDirectory = join(directoryRoot, 'saved-directory');
  await rename(chosenDirectory, savedDirectory);
  await symlink(tmpdir(), chosenDirectory);
  const deniedStart = sent.length;
  const deniedUpdate = callback(guardedNew.callback_data, directoryThread);
  await until(
    () =>
      sent
        .slice(deniedStart)
        .some(
          (message) =>
            message.message_thread_id === directoryThread &&
            message.text.includes('工作区不在此 Bot 的授权范围内'),
        ),
    'changed directory scope rejection',
  );
  assert.equal(
    (await client.call({ method: 'operation', operation: `telegram-update-${deniedUpdate}` }))
      .status,
    'unknown',
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, beforeDirectory.size + 1);
  await unlink(chosenDirectory);
  await rename(savedDirectory, chosenDirectory);
  const restoredStart = sent.length;
  callback(guardedNew.callback_data, directoryThread);
  await until(
    () => sent.slice(restoredStart).some((message) => message.text.startsWith('Session ')),
    'rejected key remains unused after scope restored',
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, beforeDirectory.size + 2);
  assert.equal((await trace()).filter((record) => record.method === 'boot').length, directoryBoots);
  check(
    'directory selection revalidates current canonical workspace before admission; escape cannot create or consume the key, and restored scope permits the original explicit choice',
  );
  const historyThread = sent.find((m) =>
    m.text.startsWith(`Session ${directorySession}`),
  ).message_thread_id;
  text('/notifications off', historyThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === historyThread &&
          message.text.startsWith('Notifications: off'),
      ),
    'mute automatic output before explicit history fixture',
  );
  await client.call({ method: 'attach', session: directorySession });
  finished = client.waitFor((batch) => turnFinished(batch, directorySession));
  text('big', historyThread);
  await finished;
  await until(
    () =>
      deliveryRecords(data).some(
        (record) =>
          record.event.payload.Turn?.session === directorySession && record.status === 'Acked',
      ),
    'large automatic body muted and retained',
  );
  await stop(daemon);
  daemon = await start();
  const historyTrace = await trace();
  const historyStart = sent.length;
  rateLimit = true;
  text('/history all', historyThread);
  await until(
    () =>
      deliveryRecords(data).some(
        (record) =>
          record.event.payload.HistoryEntry?.session === directorySession &&
          record.last_failure === 'RateLimited',
      ),
    'explicit history 429 receipt',
  );
  await stop(daemon);
  daemon = await start();
  await until(
    () =>
      sent
        .slice(historyStart)
        .some(
          (message) =>
            message.message_thread_id === historyThread &&
            message.text.startsWith(`History export · session ${directorySession}`),
        ),
    'large archived history after 429/restart',
  );
  const historyChunks = () =>
    sent
      .slice(historyStart)
      .filter(
        (message) => message.message_thread_id === historyThread && /^x+$/.test(message.text),
      );
  assert.equal(
    historyChunks()
      .map((message) => message.text)
      .join(''),
    'x'.repeat(600 * 1024),
  );
  assert(
    historyChunks().every(
      (message) => message.text.length <= 4000 && message.disable_notification === true,
    ),
  );
  assert(
    !sent
      .slice(historyStart)
      .some(
        (message) =>
          message.message_thread_id === historyThread && message.text.includes('[Archived text:'),
      ),
  );
  assert.deepEqual(
    await trace(),
    historyTrace,
    'history export/retry must stay cold and never dispatch ACP',
  );
  check(
    'explicit history streams the complete 600 KiB archived body with notifications off through persisted 429/restart, without placeholders or provider activity',
  );
  const historyCount = historyChunks().length;
  const summaries = () =>
    sent.filter(
      (message) =>
        message.message_thread_id === historyThread &&
        message.text.startsWith(`History export · session ${directorySession}`),
    );
  let summaryCount = summaries().length;
  text('/history', historyThread);
  await until(() => summaries().length > summaryCount, 'recent explicit history dedup');
  assert(summaries().at(-1).text.includes('0 new entries queued'));
  await stop(daemon);
  daemon = await start();
  summaryCount = summaries().length;
  text('/history all', historyThread);
  await until(
    () => summaries().length > summaryCount,
    'history cursor/dedup survives real restart',
  );
  assert(summaries().at(-1).text.includes('0 new entries queued'));
  assert.equal(historyChunks().length, historyCount);
  assert.deepEqual(await trace(), historyTrace);
  check(
    'recent/all history share durable per-entry export identities and chronological cursor; repeated commands across restart do not resend completed entries',
  );
  const preferenceExportStart = sent.length;
  const completedImageCount = mediaSent.length;
  text('/history all', preferenceThread);
  await until(
    () =>
      sent
        .slice(preferenceExportStart)
        .some(
          (message) =>
            message.message_thread_id === preferenceThread &&
            message.text.startsWith(`History export · session ${preferenceSession}`),
        ),
    'completed automatic output is already exported',
  );
  assert.equal(
    mediaSent.length,
    completedImageCount,
    'history must not resend a fully acknowledged automatic image',
  );
  assert(
    !sent
      .slice(preferenceExportStart)
      .some(
        (message) =>
          message.message_thread_id === preferenceThread && message.text === 'image caption',
      ),
  );
  assert.deepEqual(await trace(), historyTrace);
  check(
    'completed automatic text/image output shares durable topic-scoped export evidence with explicit history after restart; muted output remains recoverable',
  );

  await client.call({ method: 'attach', session: directorySession });
  const beforeGated = await client.call({ method: 'inspect', session: directorySession });
  const settingStart = sent.length;
  text('/notifications on', historyThread);
  await until(
    () =>
      sent
        .slice(settingStart)
        .some(
          (message) =>
            message.message_thread_id === historyThread &&
            message.text.startsWith('Notifications: on'),
        ),
    'enable final delivery for history-before-finish',
  );
  finished = client.waitFor((batch) => turnFinished(batch, directorySession));
  text('history-gated-image', historyThread);
  let gatedTurn;
  await until(async () => {
    const view = await client.call({ method: 'inspect', session: directorySession });
    gatedTurn = view.active_turn;
    return gatedTurn !== null && view.last_entry_seq >= beforeGated.last_entry_seq + 3;
  }, 'committed agent text/image before the provider finishes');
  const gatedMedia = mediaSent.length;
  const gatedHistoryStart = sent.length;
  text('/history all', historyThread);
  await until(
    () =>
      sent
        .slice(gatedHistoryStart)
        .some(
          (message) =>
            message.message_thread_id === historyThread &&
            message.text.startsWith(`History export · session ${directorySession}`),
        ),
    'explicit export while the task is active',
  );
  assert.equal(mediaSent.length, gatedMedia + 1);
  const captions = () =>
    sent.filter(
      (message) => message.message_thread_id === historyThread && message.text === 'image caption',
    );
  assert.equal(captions().length, 1);
  await writeFile(`${configGate}.history-release`, 'released');
  await finished;
  await until(
    () =>
      deliveryRecords(data).some(
        (record) => record.event.payload.Turn?.turn === gatedTurn && record.status === 'Acked',
      ),
    'final automatic turn receipt',
  );
  assert.equal(
    mediaSent.length,
    gatedMedia + 1,
    'final output must not resend an image already exported during this task',
  );
  assert.equal(captions().length, 1);
  assert(
    sent.some(
      (message) =>
        message.message_thread_id === historyThread &&
        message.text.startsWith('✅ 任务完成') &&
        message.text.includes('本轮回复已在此话题中显示。'),
    ),
  );
  await stop(daemon);
  daemon = await start();
  const afterGated = await trace();
  summaryCount = summaries().length;
  text('/history', historyThread);
  await until(
    () => summaries().length > summaryCount,
    'shared output identities survive another restart',
  );
  assert(summaries().at(-1).text.includes('0 new entries queued'));
  assert.equal(mediaSent.length, gatedMedia + 1);
  assert.equal(captions().length, 1);
  assert.deepEqual(await trace(), afterGated);
  check(
    'history exported during an active task is not resent by final automatic text/image delivery; reliable completion remains visible and shared dedup survives restart without Agent replay',
  );
  // One integrated mobile workflow, not a new collection of isolated APIs.
  let flowThread = menuThread + 500;
  let flowStart = sent.length;
  text(`/new pi ${chosenDirectory}`, flowThread);
  await until(
    () => sent.slice(flowStart).some((message) => message.text.startsWith('Session ')),
    'S4 mobile create',
  );
  const flowSession = sent
    .slice(flowStart)
    .find((message) => message.text.startsWith('Session '))
    .text.split('\n')[0]
    .slice(8);
  flowThread = sent
    .slice(flowStart)
    .find((m) => m.text.startsWith(`Session ${flowSession}`)).message_thread_id;
  const promptCountBeforeDiscovery = (await trace()).filter(
    (record) => record.method === 'session/prompt',
  ).length;
  text('/discover', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith('Provider ready without a business prompt'),
      ),
    'S4 first-task provider discovery',
  );
  const discovered = await client.call({ method: 'inspect', session: flowSession });
  assert(discovered.provider_session);
  assert.equal(discovered.last_entry_seq, 0);
  assert.equal(
    (await trace()).filter((record) => record.method === 'session/prompt').length,
    promptCountBeforeDiscovery,
  );
  text('/menu models', flowThread);
  const flowButtons = (heading) =>
    sent
      .findLast(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith(heading) &&
          message.reply_markup,
      )
      ?.reply_markup.inline_keyboard.flat();
  await until(() => flowButtons('Models'), 'S4 pre-task model menu');
  callback(
    flowButtons('Models').find((button) => button.text === 'Other').callback_data,
    flowThread,
  );
  await until(
    async () =>
      (await client.call({ method: 'inspect', session: flowSession })).config.model === 'other',
    'S4 pre-task actual model selection',
  );
  const waitingFlow = async () =>
    Object.keys(
      (await client.call({ method: 'inspect', session: flowSession })).pending_interactions,
    ).length === 1;
  const flowEcho = (body) =>
    sent.some(
      (message) => message.message_thread_id === flowThread && message.text === `echo: ${body}`,
    );
  text('permission', flowThread);
  await until(waitingFlow, 'S4 authorization');
  const queueB = text('/prompt queued-B', flowThread);
  const queueC = text('/prompt queued-C', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith(`Input ${queueC} queued`),
      ),
    'S4 durable queue feedback',
  );
  text('/queue', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith('Queued input IDs:') &&
          message.text.includes(String(queueB)) &&
          message.text.includes(String(queueC)),
      ),
    'S4 visible input IDs',
  );
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.reply_markup?.inline_keyboard
            .flat()
            .some((button) => button.text.includes('Allow once')),
      ),
    'S4 permission keyboard',
  );
  const allowFlow = sent
    .findLast(
      (message) =>
        message.message_thread_id === flowThread &&
        message.reply_markup?.inline_keyboard
          .flat()
          .some((button) => button.text.includes('Allow once')),
    )
    .reply_markup.inline_keyboard.flat()
    .find((button) => button.text.includes('Allow once'));
  callback(allowFlow.callback_data, flowThread);
  await until(
    () => flowEcho('queued-B') && flowEcho('queued-C'),
    'S4 queued inputs execute after authorization',
  );
  const queuedTrace = (await trace()).filter(
    (record) =>
      record.method === 'session/prompt' && ['queued-B', 'queued-C'].includes(record.text),
  );
  assert.deepEqual(
    queuedTrace.map((record) => record.text),
    ['queued-B', 'queued-C'],
  );
  text('permission', flowThread);
  await until(waitingFlow, 'S4 stop waiting task');
  const discardedStop = text('/prompt never-run-before-stop', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith(`Input ${discardedStop} queued`),
      ),
    'S4 stop queue range',
  );
  flowStart = sent.length;
  text('/stop', flowThread);
  await until(
    () =>
      sent
        .slice(flowStart)
        .some(
          (message) =>
            message.message_thread_id === flowThread &&
            message.text.startsWith('Cancelled.') &&
            message.text.includes(String(discardedStop)),
        ),
    'S4 stop barrier result',
  );
  text('permission', flowThread);
  await until(waitingFlow, 'S4 interrupt waiting task');
  const discardedInterrupt = text('/prompt never-run-before-interrupt', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith(`Input ${discardedInterrupt} queued`),
      ),
    'S4 interrupt queue range',
  );
  text('/interrupt replacement-input', flowThread);
  await until(
    () => flowEcho('replacement-input'),
    'S4 stopped old worker then accepted replacement',
  );
  assert(
    !(await trace()).some((record) =>
      ['never-run-before-stop', 'never-run-before-interrupt'].includes(record.text),
    ),
  );
  text('permission', flowThread);
  await until(waitingFlow, 'S4 restart with accepted queue');
  const survived = text('/prompt survives-queue-restart', flowThread);
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith(`Input ${survived} queued`),
      ),
    'S4 queue persisted before restart',
  );
  const permissionsBeforeRestart = (await trace()).filter(
    (record) => record.method === 'session/prompt' && record.text === 'permission',
  ).length;
  await stop(daemon);
  daemon = await start();
  await until(
    () => flowEcho('survives-queue-restart'),
    'S4 recover accepted queued input without replaying old turn',
  );
  assert.equal(
    (await trace()).filter(
      (record) => record.method === 'session/prompt' && record.text === 'survives-queue-restart',
    ).length,
    1,
  );
  assert.equal(
    (await trace()).filter(
      (record) => record.method === 'session/prompt' && record.text === 'permission',
    ).length,
    permissionsBeforeRestart,
  );
  await client.call({
    method: 'prompt',
    session: flowSession,
    prompt: { parts: [{ type: 'text', text: 'desktop input mirror' }] },
  });
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text === '你（VS Code）：\ndesktop input mirror',
      ) && flowEcho('desktop input mirror'),
    'S4 automatic desktop input and output synchronization',
  );
  const mirrorCount = sent.filter(
    (message) =>
      message.message_thread_id === flowThread &&
      message.text === '你（VS Code）：\ndesktop input mirror',
  ).length;
  flowStart = sent.length;
  text('/history all', flowThread);
  await until(
    () =>
      sent
        .slice(flowStart)
        .some(
          (message) =>
            message.message_thread_id === flowThread &&
            message.text.startsWith(`History export · session ${flowSession}`),
        ),
    'S4 history after input/output synchronization',
  );
  assert.equal(
    sent.filter(
      (message) =>
        message.message_thread_id === flowThread &&
        message.text === '你（VS Code）：\ndesktop input mirror',
    ).length,
    mirrorCount,
  );
  // Preview uses the same sender lanes, no durable delta intents, and edits one message.
  await rm(`${configGate}.history-release`, { force: true });
  await rm(`${configGate}.history-more`, { force: true });
  const previewStart = sent.length;
  const editStart = edits.length;
  const previewMedia = mediaSent.length;
  text('history-gated-image', flowThread);
  await until(
    () =>
      sent
        .slice(previewStart)
        .some(
          (message) =>
            message.message_thread_id === flowThread &&
            message.text.startsWith('Running · preview only'),
        ),
    'S4 throttled running preview',
  );
  await writeFile(`${configGate}.history-more`, 'more');
  await until(
    () => edits.slice(editStart).some((message) => message.text.includes('preview tail update')),
    'S4 preview edit/coalescing',
  );
  assert.equal(
    sent
      .slice(previewStart)
      .filter(
        (message) =>
          message.message_thread_id === flowThread &&
          message.text.startsWith('Running · preview only'),
      ).length,
    1,
  );
  assert(
    sent.slice(previewStart).find((message) => message.text.startsWith('Running · preview only'))
      .disable_notification,
  );
  await writeFile(`${configGate}.history-release`, 'released');
  await until(
    () =>
      mediaSent.length === previewMedia + 1 &&
      sent
        .slice(previewStart)
        .some(
          (message) =>
            message.message_thread_id === flowThread &&
            !message.text.startsWith('Running ·') &&
            message.text.includes('image caption') &&
            message.text.includes('preview tail update'),
        ),
    'S4 reliable final output is not replaced by preview',
  );
  const syncTrace = await trace();
  const syncStart = sent.length;
  text('/sync', undefined);
  await until(
    () =>
      sent
        .slice(syncStart)
        .some(
          (message) =>
            !message.message_thread_id && message.text.startsWith('Sync:') && message.reply_markup,
        ),
    'S4 bounded cross-session sync',
  );
  const syncReply = sent
    .slice(syncStart)
    .find(
      (message) =>
        !message.message_thread_id && message.text.startsWith('Sync:') && message.reply_markup,
    );
  assert(
    syncReply.reply_markup.inline_keyboard
      .flat()
      .some((button) => button.text === 'Sync next session page'),
  );
  assert.deepEqual(await trace(), syncTrace, 'sync must not start or replay a provider');
  const topicsAfterSync = topics;
  const syncAgainStart = sent.length;
  text('/sync', undefined);
  await until(
    () =>
      sent
        .slice(syncAgainStart)
        .some((message) => !message.message_thread_id && message.text.startsWith('Sync:')),
    'S4 repeat sync',
  );
  assert.equal(
    topics,
    topicsAfterSync,
    'repeat sync reuses existing bindings and durable topic effects',
  );
  check(
    'S4 integrated mobile create → pre-task discover/model → A/B queue → authorize → stop/interrupt barriers → restart queue → input/output/history → throttled edit preview/reliable final → cross-session sync, without queued-input or Agent replay',
  );
  const topicCountBeforeDesktop = topics;
  const providerCountBeforeDesktop = (await trace()).filter((r) => r.method === 'boot').length;
  const desktop = (await client.call({ method: 'create', harness: 'Pi', cwd: root })).Created
    .summary;
  await until(
    () =>
      topics > topicCountBeforeDesktop && topicNames.includes(`#${desktop.created_seq} · 新对话`),
    'desktop session automatically creates its forum topic',
  );
  await client.call({
    method: 'manage',
    session: desktop.id,
    action: { action: 'rename', title: 'Desktop 中文 😀' },
  });
  await until(
    () => topicTitleEdits.some((m) => m.name === `#${desktop.created_seq} · Desktop 中文 😀`),
    'desktop topic title follows manual rename',
  );
  assert.equal(
    (await trace()).filter((r) => r.method === 'boot').length,
    providerCountBeforeDesktop,
  );
  check(
    'classic desktop auto-topic/title mirror remains cold and shares stable creation receipts with explicit sync',
  );
  await stop(daemon);
  console.log(`\n${checks} new-workbench Telegram/IPC contract checks passed`);
} finally {
  client?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.allSettled([...children].map((child) => child.done));
  for (const record of (await trace()).filter((record) => record.method === 'boot')) {
    try {
      if ((await readFile(`/proc/${record.pid}/cmdline`, 'utf8')).includes(agent))
        process.kill(-record.pid, 'SIGKILL');
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
