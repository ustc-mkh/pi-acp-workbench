// Opt-in sustained load on a production session daemon and an isolated test relay.
// Only ACP/Bot transports are mocked; never reads user service data or credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ContractWire } from './lib/contract-wire.mjs';

const duration = Number(process.env.PI_SOAK_SECONDS || 7200) * 1000;
assert(Number.isFinite(duration) && duration >= 10000, 'PI_SOAK_SECONDS must be >= 10');
const phoneRotation = Number(process.env.PI_SOAK_PHONE_ROTATION || 100);
const relayPeriod = Number(process.env.PI_SOAK_RELAY_RESTART_SECONDS || 900) * 1000;
const servicePeriod = Number(process.env.PI_SOAK_SERVICE_RESTART_SECONDS || 2700) * 1000;
assert(Number.isInteger(phoneRotation) && phoneRotation > 0);
assert(Number.isFinite(relayPeriod) && relayPeriod >= 5000);
assert(Number.isFinite(servicePeriod) && servicePeriod >= 10000);
const reportDir = resolve(process.env.PI_ACCEPTANCE_DIR || '.test-results/service-soak');
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'pi-service-soak-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
execFileSync('git', ['init', '-q', workspace]);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`soak timeout: ${label}`);
}
const counters = {
  cycles: 0,
  prompts: 0,
  duplicates: 0,
  connections: 0,
  events: 0,
  cancellations: 0,
  permissions: 0,
  removals: 0,
  relayRestarts: 0,
  serviceRestarts: 0,
  apiCalls: 0,
  deliveries: 0,
  workerPids: 0,
};
let updates = [],
  updateId = 0,
  messageId = 0,
  topicId = 700;
// Retain only the most recent sends so the test driver itself is bounded.
const sent = [];
const message = (text, thread) =>
  updates.push({
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      chat: { id: -1009999, type: 'supergroup' },
      from: { id: 42 },
      text,
      ...(thread ? { message_thread_id: thread } : {}),
    },
  });
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    counters.apiCalls++;
    const method = req.url.slice(1),
      params = JSON.parse(body || '{}');
    const reply = (result) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') return reply({ id: 123, username: 'soak_bot' });
    if (method === 'getWebhookInfo') return reply({ url: '' });
    if (method === 'getChat') return reply({ id: -1009999, type: 'supergroup', is_forum: true });
    if (method === 'getUpdates') {
      if (!updates.length) await delay(100);
      const batch = updates.filter((u) => u.update_id >= (params.offset || 0));
      updates = updates.filter((u) => u.update_id < (params.offset || 0));
      return reply(batch);
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      const responseId = method === 'editMessageText' ? params.message_id : ++messageId;
      sent.push({ method, params, messageId: responseId });
      if (sent.length > 200) sent.shift();
      if (method === 'sendMessage') counters.deliveries++;
      return reply({ message_id: responseId });
    }
    if (method === 'createForumTopic') return reply({ message_thread_id: ++topicId });
    return reply(true);
  });
});
await new Promise((done) => api.listen(0, '127.0.0.1', done));
const sessionsConfig = join(root, 'sessions.json'),
  telegramConfig = join(root, 'telegram.json');
await writeFile(
  sessionsConfig,
  JSON.stringify({
    command: process.execPath,
    args: [resolve('test/contract-agent.mjs')],
    maxWorkers: 2,
    idleMs: 1500,
  }),
);
await writeFile(
  telegramConfig,
  JSON.stringify({
    chatId: -1009999,
    allowedUserIds: [42],
    workspaces: { main: workspace },
    restrictToWorkspaces: true,
  }),
);
const sessionSource = resolve(
  process.env.PI_SOAK_SESSION_DAEMON || 'service-dist/pi-acp-session-daemon',
);
const relaySource = resolve(
  process.env.PI_SOAK_RELAY_DAEMON || 'rust/target/contract/debug/pi-acp-telegram-daemon',
);
// A concurrent rebuild must not silently change the executable at the next restart.
const sessionBytes = await readFile(sessionSource);
const relayBytes = await readFile(relaySource);
const sessionBinary = join(root, 'session-daemon');
const relayBinary = join(root, 'telegram-daemon');
await writeFile(sessionBinary, sessionBytes, { mode: 0o755 });
await writeFile(relayBinary, relayBytes, { mode: 0o755 });
const metadata = {
  durationSeconds: duration / 1000,
  root,
  sessionBinary,
  relayBinary,
  sessionSource,
  relaySource,
  sessionSha256: createHash('sha256').update(sessionBytes).digest('hex'),
  relaySha256: createHash('sha256').update(relayBytes).digest('hex'),
  mockBot: true,
  mockAcp: true,
  productionSession: true,
  maxWorkers: 2,
  idleMs: 1500,
  phoneRotation,
  relayRestartSeconds: relayPeriod / 1000,
  serviceRestartSeconds: servicePeriod / 1000,
};
await writeFile(join(reportDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const children = [],
  observedWorkers = new Set(),
  retiredPhoneIds = new Set(),
  samples = [];
async function start(binary, config, name, extra = {}) {
  const child = spawn(binary, ['--config', config, '--data-dir', root], {
    env: { ...process.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '',
    errors = '';
  child.stdout.on('data', (data) => (output = (output + data).slice(-8000)));
  child.stderr.on('data', (data) => {
    errors = (errors + data).slice(-8000);
    appendFile(join(reportDir, `${name}.stderr.log`), data).catch(() => {});
  });
  await until(() => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${name} exited at startup: ${errors}`);
    return output.includes('ready');
  }, `${name} ready`);
  return child;
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await exited;
    assert.equal(child.signalCode, null, 'daemon needed forced stop');
  } finally {
    clearTimeout(timer);
  }
}
const relayEnv = {
  PI_TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  PI_TELEGRAM_API_BASE: `http://127.0.0.1:${api.address().port}`,
  PI_TELEGRAM_PACE_MS: '1',
};
let service,
  relay,
  client,
  phoneId,
  scratchId,
  started,
  nextReport,
  nextRelay,
  nextService,
  outcome;
const bindingFile = join(root, 'telegram', 'bot-123-chat--1009999.json');
async function resources(child) {
  assert.equal(child.exitCode, null, 'unexpected daemon exit');
  assert.equal(child.signalCode, null, 'unexpected daemon signal');
  const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
  // Tokio can spawn from any runtime thread; the main thread's children list is insufficient.
  const tasks = await readdir(`/proc/${child.pid}/task`);
  const workers = [
    ...new Set(
      (
        await Promise.all(
          tasks.map(async (tid) => {
            try {
              return (await readFile(`/proc/${child.pid}/task/${tid}/children`, 'utf8'))
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map(Number);
            } catch (error) {
              if (error.code === 'ENOENT') return [];
              throw error;
            }
          }),
        )
      ).flat(),
    ),
  ];
  for (const pid of workers) observedWorkers.add(pid);
  counters.workerPids = observedWorkers.size;
  return {
    pid: child.pid,
    rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)[1]),
    fd: (await readdir(`/proc/${child.pid}/fd`)).length,
    workers,
  };
}
async function sample(phase) {
  const item = {
    at: new Date().toISOString(),
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    phase,
    service: await resources(service),
    relay: await resources(relay),
    counters: { ...counters },
  };
  assert(item.service.workers.length <= 2, 'worker limit exceeded');
  assert.equal(item.relay.workers.length, 0, 'relay spawned a worker');
  // Large safety ceilings supplement the steady-state comparison at the end.
  assert(
    item.service.rssKiB < 192 * 1024 && item.relay.rssKiB < 192 * 1024,
    'RSS ceiling exceeded',
  );
  assert(item.service.fd < 40 && item.relay.fd < 40, 'FD ceiling exceeded');
  samples.push(item);
  await appendFile(join(reportDir, 'samples.jsonl'), JSON.stringify(item) + '\n');
  if (phase !== 'load') console.log(JSON.stringify(item));
}
const prompt = async (id, text, requestId) => {
  const params = { sessionId: id, prompt: [{ type: 'text', text }], source: 'desktop' };
  const result = await client.call('prompt', params, requestId);
  counters.prompts++;
  if (requestId) {
    assert.deepEqual(await client.call('prompt', params, requestId), result);
    counters.duplicates++;
  }
};
const delivered = (text) =>
  sent.some((s) => s.method === 'sendMessage' && s.params.text?.includes(text));
async function newPhoneSession() {
  const previous = messageId;
  message('/new main');
  const chooser = await until(
    () =>
      sent.findLast(
        (s) =>
          s.method === 'sendMessage' &&
          s.messageId > previous &&
          s.params.text?.includes('选择 Harness'),
      ),
    'harness chooser',
  );
  const data = chooser.params.reply_markup.inline_keyboard
    .flat()
    .find((b) => /Pi$/.test(b.text)).callback_data;
  updates.push({
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 42 },
      data,
      message: { message_id: chooser.messageId, chat: { id: -1009999, type: 'supergroup' } },
    },
  });
}
try {
  service = await start(sessionBinary, sessionsConfig, 'sessions');
  relay = await start(relayBinary, telegramConfig, 'telegram', relayEnv);
  client = await ContractWire.open(join(root, 'service', 'sessions.sock'));
  await newPhoneSession();
  const binding = await until(async () => {
    try {
      return JSON.parse(await readFile(bindingFile, 'utf8')).topics[0];
    } catch {
      return undefined;
    }
  }, 'phone binding');
  phoneId = binding.sessionId;
  scratchId = (await client.call('create', { cwd: workspace })).id;
  await client.call('_watch', { sessionId: scratchId, enabled: true });
  started = Date.now();
  nextReport = started;
  nextRelay = started + relayPeriod;
  nextService = started + servicePeriod;
  while (Date.now() - started < duration) {
    const cycleStart = Date.now(),
      n = ++counters.cycles;
    // Hold one worker while another completes; verify actual process capacity under load.
    const pending = client.call('prompt', {
      sessionId: scratchId,
      prompt: [{ type: 'text', text: 'wait' }],
      source: 'desktop',
    });
    pending.catch(() => {}); // Cleanup can disconnect this pending call if a later assertion fails.
    await until(
      async () => (await client.call('state', { sessionId: scratchId })).busy,
      'held prompt',
    );
    assert.equal(
      (await client.call('list')).find((s) => s.id === scratchId)?.busy,
      true,
      'background held session must be busy in history',
    );
    await prompt(phoneId, `soak-${n}`, `soak-request-${n}`);
    await sample(n === 1 ? 'startup-load' : 'load');
    await client.call('cancel', { sessionId: scratchId });
    await pending;
    await until(
      async () => (await client.call('list')).find((s) => s.id === scratchId)?.busy === false,
      'history busy clears after cancellation',
    );
    counters.prompts++;
    counters.cancellations++;
    await until(() => delivered(`echo: soak-${n}`), 'desktop outbox delivery');
    const connection = await ContractWire.open(join(root, 'service', 'sessions.sock'));
    assert.equal((await connection.call('hello')).protocolVersion, 1);
    connection.close();
    counters.connections++;
    counters.events += client.events.length;
    client.events.length = 0;
    if (n % 20 === 0) {
      const permission = client.call('prompt', {
        sessionId: scratchId,
        prompt: [{ type: 'text', text: 'permission' }],
        source: 'desktop',
      });
      permission.catch(() => {});
      const card = await until(
        async () => (await client.call('state', { sessionId: scratchId })).permissions[0],
        'permission',
      );
      await client.call('permission', {
        sessionId: scratchId,
        permissionId: card.id,
        optionId: 'yes',
      });
      await permission;
      counters.permissions++;
      counters.prompts++;
      await client.call('_watch', { sessionId: scratchId, enabled: false });
      await client.call('remove', { sessionId: scratchId });
      counters.removals++;
      scratchId = (await client.call('create', { cwd: workspace })).id;
      await client.call('_watch', { sessionId: scratchId, enabled: true });
    }
    // Bound the phone history while preserving its binding/session ID across restarts.
    // A fresh bound topic every 100 turns exercises durable remove/create and outbox cleanup.
    if (n % phoneRotation === 0) {
      await client.call('remove', { sessionId: phoneId });
      counters.removals++;
      retiredPhoneIds.add(phoneId);
      // Outbox delivery also creates topics for desktop scratch sessions. Select
      // only a newly created binding, never an older (possibly deleted) topic.
      const previousThread = Math.max(
        ...JSON.parse(await readFile(bindingFile, 'utf8')).topics.map((t) => t.threadId),
      );
      await newPhoneSession();
      phoneId = (
        await until(async () => {
          const topics = JSON.parse(await readFile(bindingFile, 'utf8')).topics;
          return topics.find(
            (t) => t.threadId > previousThread && !retiredPhoneIds.has(t.sessionId),
          );
        }, 'new bounded phone session')
      ).sessionId;
    }
    if (Date.now() >= nextRelay) {
      const before = JSON.parse(await readFile(bindingFile, 'utf8'));
      const liveIds = new Set((await client.call('list')).map((s) => s.id));
      await stop(relay);
      const text = `offline-${n}`;
      await prompt(phoneId, text);
      relay = await start(relayBinary, telegramConfig, 'telegram', relayEnv);
      await until(() => delivered(`echo: ${text}`), 'restart outbox delivery');
      const after = JSON.parse(await readFile(bindingFile, 'utf8'));
      await appendFile(
        join(reportDir, 'restart-checks.jsonl'),
        JSON.stringify({
          cycle: n,
          before: before.topics,
          liveIds: [...liveIds],
          after: after.topics,
        }) + '\n',
      );
      // Startup prunes deleted bindings, while pending desktop outbox events may
      // legitimately create a new topic. Verify identities, not table equality.
      for (const topic of before.topics.filter((t) => liveIds.has(t.sessionId)))
        assert.deepEqual(
          after.topics.find((t) => t.sessionId === topic.sessionId),
          topic,
        );
      for (const topic of after.topics)
        assert(liveIds.has(topic.sessionId), `restart bound a deleted session: ${topic.sessionId}`);
      assert.equal(new Set(after.topics.map((t) => t.sessionId)).size, after.topics.length);
      assert.equal(new Set(after.topics.map((t) => t.threadId)).size, after.topics.length);
      assert(after.offset >= before.offset);
      assert.equal(
        sent.filter((s) => s.method === 'sendMessage' && s.params.text?.includes(`echo: ${text}`))
          .length,
        1,
      );
      counters.relayRestarts++;
      nextRelay += relayPeriod;
    }
    if (Date.now() >= nextService) {
      const before = (await client.call('state', { sessionId: phoneId })).snapshot.entries;
      await stop(relay);
      client.close();
      await stop(service);
      service = await start(sessionBinary, sessionsConfig, 'sessions');
      client = await ContractWire.open(join(root, 'service', 'sessions.sock'));
      assert.deepEqual(
        (await client.call('state', { sessionId: phoneId })).snapshot.entries,
        before,
      );
      await client.call('_watch', { sessionId: scratchId, enabled: true });
      relay = await start(relayBinary, telegramConfig, 'telegram', relayEnv);
      counters.serviceRestarts++;
      counters.relayRestarts++;
      nextService += servicePeriod;
    }
    await delay(Math.max(1600, 5000 - (Date.now() - cycleStart)));
    if (Date.now() >= nextReport) {
      await until(
        async () => (await resources(service)).workers.length === 0,
        'idle worker reclamation',
      );
      await sample('idle');
      nextReport = Date.now() + 60000;
    }
  }
  await until(
    async () => (await resources(service)).workers.length === 0,
    'final worker reclamation',
  );
  await sample('final');
  const idle = samples.filter(
    (s) => s.phase === 'idle' && s.elapsedSeconds >= Math.min(600, duration / 4000),
  );
  for (const kind of ['service', 'relay']) {
    if (idle.length >= 3) {
      const first = idle[Math.floor(idle.length / 4)][kind],
        last = samples.at(-1)[kind];
      assert(last.rssKiB <= first.rssKiB + 32 * 1024, `${kind} sustained RSS growth`);
      assert(last.fd <= first.fd + 3, `${kind} leaked FDs`);
    }
  }
  outcome = {
    passed: true,
    ...metadata,
    started: new Date(started).toISOString(),
    elapsedSeconds: (Date.now() - started) / 1000,
    counters,
    sampleCount: samples.length,
    final: samples.at(-1),
  };
} catch (error) {
  outcome = {
    passed: false,
    ...metadata,
    error: String(error.stack || error),
    counters,
    elapsedSeconds: started ? (Date.now() - started) / 1000 : 0,
  };
  throw error;
} finally {
  try {
    client?.close();
    for (const child of children.reverse()) await stop(child);
    await new Promise((done) => api.close(done));
    for (const pid of observedWorkers) {
      try {
        await readFile(`/proc/${pid}/status`);
        assert.fail(`orphan worker ${pid}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
    if (outcome) outcome.orphanWorkers = 0;
  } catch (error) {
    outcome = { ...outcome, passed: false, cleanupError: String(error.stack || error) };
    throw error;
  } finally {
    if (outcome)
      await writeFile(join(reportDir, 'result.json'), JSON.stringify(outcome, null, 2) + '\n');
  }
}
console.log('PASS sustained service soak');
