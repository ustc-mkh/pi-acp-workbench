import { archivedEntry, imageArchive, noticeText } from './lib/workbench-sqlite-fixture.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';
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
let acknowledgements = 0;
let rateLimit = false;
let rateFailures = 0;
let fatalPoll = false;
let checks = 0;
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
  throw new Error(`timeout: ${description}`);
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
  else if (method === 'getUpdates') {
    assert.deepEqual(body.allowed_updates, ['message', 'callback_query']);
    if (fatalPoll) error = { error_code: 401, description: `DO NOT LOG ${token}` };
    else result = updates.filter((update) => update.update_id >= body.offset);
  } else if (method === 'createForumTopic') result = { message_thread_id: 100 + ++topics };
  else if (method === 'sendMessage') {
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
  assert(!child.output.includes(token), 'bot token must never appear in daemon output');
}
async function rateLimitedPending() {
  for (const name of await readdir(join(data, 'outbox'))) {
    if (!name.endsWith('.json')) continue;
    const { body } = JSON.parse(await readFile(join(data, 'outbox', name), 'utf8'));
    if (body.status === 'Pending' && body.last_failure === 'RateLimited') return true;
  }
  return false;
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
    async () =>
      (await client.call({ method: 'list' }))[0].SessionsListed.length === 1 && sent.length > 0,
    'forum session creation',
  );
  const session = (await client.call({ method: 'list' }))[0].SessionsListed[0].id;
  const thread = sent[0].message_thread_id;
  assert.equal(topics, 1);
  assert(thread);
  await client.call({ method: 'subscribe', session });
  check('one host creates forum topic and session through its shared runtime');
  let finished = client.waitFor((event) => event.TurnFinished);
  text('你好', thread);
  await finished;
  await until(() => sent.some((message) => message.text === 'echo: 你好'), 'Telegram agent output');
  check('Telegram prompt produces IPC events and durable Telegram output');
  const interaction = client.waitFor((event) => event.InteractionRequested);
  await client.call({ method: 'prompt', session, prompt: 'permission' }, 'contract-permission');
  const requested = (await interaction).InteractionRequested.interaction.id;
  await until(() => sent.some((message) => message.reply_markup), 'permission keyboard');
  const key = sent.find((message) => message.reply_markup).reply_markup.inline_keyboard[0][0]
    .callback_data;
  callback(key, thread + 1);
  callback(key, thread, 6);
  await until(() => acknowledgements >= 2, 'rejected callback acknowledgement');
  const waiting = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
  assert(waiting.pending_interactions[requested]);
  finished = client.waitFor((event) => event.TurnFinished);
  callback(key, thread);
  await finished;
  assert.deepEqual(
    (await client.call({ method: 'inspect', session }))[0].SessionLoaded.pending_interactions,
    {},
  );
  check(
    'IPC permission → Telegram UI → typed response; wrong-topic/unauthorized callbacks cannot consume it',
  );
  await until(
    () => sent.some((message) => message.text === 'Turn completed.'),
    'permission completion delivery',
  );
  rateLimit = true;
  finished = client.waitFor((event) => event.TurnFinished);
  text('retry-output', thread);
  await finished;
  await until(() => rateFailures === 1, 'rate-limited send');
  await until(rateLimitedPending, 'persisted retry metadata');
  const nativeBeforeRestart = (await client.call({ method: 'inspect', session }))[0].SessionLoaded
    .provider_session;
  await stop(daemon);
  daemon = await start();
  await client.call({ method: 'subscribe', session });
  const nativeResumed = client.waitFor((event) => event.TurnFinished?.session === session);
  text('telegram native resume', thread);
  await nativeResumed;
  assert.equal(
    (await client.call({ method: 'inspect', session }))[0].SessionLoaded.provider_session,
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
  assert.equal((await client.call({ method: 'list' }))[0].SessionsListed.length, 1);
  check(
    '429 retry metadata survives restart without rerunning the agent or duplicating topic/session',
  );
  mediaRateLimit = true;
  const imageOrderStart = sendOrder.length;
  finished = client.waitFor((event) => event.TurnFinished);
  text('image-output', thread);
  await finished;
  await until(() => mediaRateFailures === 1, 'rate-limited multipart image');
  await until(rateLimitedPending, 'persisted image retry');
  text('/help', thread);
  let laterNotice;
  await until(async () => {
    for (const name of await readdir(join(data, 'outbox'))) {
      if (!name.endsWith('.json')) continue;
      const { body } = JSON.parse(await readFile(join(data, 'outbox', name), 'utf8'));
      if (body.status === 'Pending' && body.event.target.Telegram && body.event.payload.Notice) {
        laterNotice = noticeText(data, body.event.payload.Notice.notice);
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
  await client.call({ method: 'subscribe', session });
  await until(
    () => mediaSent.length === 1 && sent.some((message) => message.text === 'image caption'),
    'archived image retry after restart',
  );
  const imageRow = (
    await client.call({ method: 'inspect', session })
  )[0].SessionLoaded.transcript.entries.find((entry) => entry.image);
  const imageRecord = imageArchive(data, imageRow.image.id);
  assert.deepEqual(mediaSent[0].file.bytes, Buffer.from(imageRecord.data, 'base64'));
  assert.equal(mediaSent[0].thread, thread);
  assert.equal(mediaSent[0].chat, -100);
  assert.equal(mediaSent[0].method, 'sendPhoto');
  assert.equal(mediaSent[0].file.filename, `${imageRow.image.id}.png`);
  await until(
    () => sent.some((message) => message.text === laterNotice),
    'later notice follows image after restart',
  );
  assert.deepEqual(sendOrder.slice(imageOrderStart), [
    'image',
    'text:image caption',
    `text:${laterNotice}`,
  ]);
  assert.equal((await trace()).filter((record) => record.text === 'image-output').length, 1);
  check(
    'multipart image retry survives restart, preserves archived bytes/topic/order and never reruns the agent',
  );
  check(
    'a later same-topic control notice cannot overtake a deferred image, including across restart',
  );
  await client.call({ method: 'load', session });
  const envText = client.waitFor((event) => event.AgentText?.text === 'bot-env-hidden');
  finished = client.waitFor((event) => event.TurnFinished);
  await client.call({ method: 'prompt', session, prompt: 'check-bot-env' });
  await envText;
  await finished;
  check('actual ACP child cannot inherit the bot token environment variable');
  finished = client.waitFor((event) => event.TurnFinished);
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
  const otherThread = thread + 1;
  text('/new', otherThread);
  await until(
    async () => (await client.call({ method: 'list' }))[0].SessionsListed.length === 2,
    'independent topic creation',
  );
  const otherSession = (await client.call({ method: 'list' }))[0].SessionsListed.find(
    (entry) => entry.id !== session,
  ).id;
  await until(
    () =>
      sent.some(
        (message) =>
          message.message_thread_id === otherThread && message.text.startsWith('Session '),
      ),
    'independent topic binding',
  );
  await client.call({ method: 'subscribe', session: otherSession });
  const independent = client.waitFor((event) => event.TurnFinished?.session === otherSession);
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
  assert((await client.call({ method: 'inspect', session }))[0].SessionLoaded.configuration_intent);
  check(
    'a blocked Telegram provider leaves other topics, IPC and same-topic status queries responsive',
  );
  await writeFile(`${configGate}.release`, 'release');
  await until(async () => {
    const state = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    return state.config.model === 'other' && !state.configuration_intent;
  }, 'Telegram setting completion');
  holdMedia = true;
  const mediaStart = sent.length;
  finished = client.waitFor((event) => event.TurnFinished?.session === session);
  text('image-output', thread);
  await finished;
  await until(() => mediaHolds === 1, 'in-flight multipart HTTP hold');
  text('/help', thread);
  const mediaIndependent = client.waitFor((event) => event.TurnFinished?.session === otherSession);
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
        .some((message) => message.message_thread_id === thread && message.text === laterNotice),
    'same-topic notice after held upload completes',
  );
  assert.deepEqual(
    sent
      .slice(mediaStart)
      .filter(
        (message) =>
          message.message_thread_id === thread &&
          [laterNotice, 'image caption'].includes(message.text),
      )
      .map((message) => message.text),
    ['image caption', laterNotice],
  );
  check(
    'an in-flight image HTTP request does not block another topic, while later same-topic output remains FIFO',
  );
  const traceStart = (await trace()).length;
  const cancelInteraction = client.waitFor((event) => event.InteractionRequested);
  await client.call({ method: 'prompt', session, prompt: 'permission' });
  await cancelInteraction;
  const cancelled = await client.call({ method: 'cancel', session });
  assert(cancelled.some((event) => event.TurnCancelled));
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
  finished = client.waitFor((event) => event.TurnFinished?.session === session);
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
  assert(
    !(await client.call({ method: 'list' }))[0].SessionsListed.some(
      (entry) => entry.id === session,
    ),
  );
  fatalPoll = true;
  await until(
    () => daemon.exitCode !== null,
    'fatal cleanup with a blocked Telegram record and image HTTP',
  );
  await until(() => mediaClosed === 1, 'cancelled image HTTP socket closed');
  let pendingImage;
  for (const name of await readdir(join(data, 'outbox'))) {
    if (!name.endsWith('.json')) continue;
    const { body } = JSON.parse(await readFile(join(data, 'outbox', name), 'utf8'));
    if (body.status !== 'Pending' || !body.event.payload.SessionCompleted) continue;
    for (const entry of body.event.payload.SessionCompleted.entries) {
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
  assert(
    !(await client.call({ method: 'list' }))[0].SessionsListed.some(
      (entry) => entry.id === session,
    ),
  );
  check(
    'frozen workspace scope authorizes the original bound topic after external source deletion and restart, without ACP or different bytes',
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
