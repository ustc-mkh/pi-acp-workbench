// Historical release -> current production services -> restored historical release.
// Archives old source into /tmp; never reinstates a second implementation in this tree.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { ContractWire } from './lib/contract-wire.mjs';

const baseline = process.env.PI_ROLLBACK_REF || 'v0.9.4';
const commit = execFileSync('git', ['rev-parse', `${baseline}^{commit}`], {
  encoding: 'utf8',
}).trim();
const reportDir = resolve(process.env.PI_ACCEPTANCE_DIR || '.test-results/service-rollback');
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'pi-service-rollback-'));
const oldRoot = join(root, 'old'),
  data = join(root, 'data'),
  backup = join(root, 'backup');
const workspace = join(root, 'workspace');
await Promise.all([oldRoot, data, workspace].map((p) => mkdir(p)));
execFileSync('git', ['init', '-q', workspace]);
execFileSync('tar', ['-x', '-C', oldRoot], {
  input: execFileSync('git', ['archive', commit], { maxBuffer: 64 * 1024 * 1024 }),
});
await symlink(resolve('node_modules'), join(oldRoot, 'node_modules'));
const oldPackage = JSON.parse(await readFile(join(oldRoot, 'package.json'), 'utf8'));
for (const dependency of ['@agentclientprotocol/sdk', 'proper-lockfile']) {
  const actual = JSON.parse(
    await readFile(resolve('node_modules', dependency, 'package.json'), 'utf8'),
  ).version;
  assert.equal(actual, oldPackage.dependencies[dependency], `historical dependency ${dependency}`);
}
await mkdir(join(oldRoot, 'dist'));
for (const kind of ['session', 'telegram']) {
  await build({
    entryPoints: [join(oldRoot, 'src', `${kind}-daemon.ts`)],
    outfile: join(oldRoot, 'dist', `${kind}-daemon.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __acceptanceRequire } from "node:module"; const require = __acceptanceRequire(import.meta.url);',
    },
  });
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`rollback timeout: ${label}`);
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory) {
  const result = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result[relative(directory, file)] = sha(await readFile(file));
      else assert.fail(`live socket/special file in stopped backup: ${file}`);
    }
  }
  await walk(directory);
  return result;
}
let updateId = 0,
  messageId = 0,
  topicId = 700,
  updates = [];
const sent = [],
  children = [],
  checks = [];
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
const callback = (data, thread) =>
  updates.push({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: 42 },
      data,
      message: {
        message_id: ++messageId,
        chat: { id: -1009999, type: 'supergroup' },
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
    if (method === 'getMe') return reply({ id: 123, username: 'rollback_bot' });
    if (method === 'getWebhookInfo') return reply({ url: '' });
    if (method === 'getChat') return reply({ id: -1009999, type: 'supergroup', is_forum: true });
    if (method === 'getUpdates') {
      if (!updates.length) await delay(100);
      const batch = updates.filter((u) => u.update_id >= (params.offset || 0));
      updates = updates.filter((u) => u.update_id < (params.offset || 0));
      return reply(batch);
    }
    sent.push({ method, params });
    if (method === 'createForumTopic') return reply({ message_thread_id: ++topicId });
    if (method === 'sendMessage' || method === 'editMessageText')
      return reply({ message_id: ++messageId });
    return reply(true);
  });
});
await new Promise((done) => api.listen(0, '127.0.0.1', done));
const apiBase = `http://127.0.0.1:${api.address().port}`;
// The historical daemon has no test hooks. A process-local preload replaces fetch's
// destination in this isolated fixture only; its original source remains unchanged.
const preload = join(root, 'bot-preload.mjs');
await writeFile(
  preload,
  `const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const source = new URL(url);
  if (source.origin !== 'https://api.telegram.org') throw new Error('unexpected external request');
  return fetch(${JSON.stringify(apiBase)} + '/' + source.pathname.split('/').at(-1), options);
};\n`,
);
const sessionConfig = join(root, 'sessions.json'),
  telegramConfig = join(root, 'telegram.json');
await writeFile(
  sessionConfig,
  JSON.stringify({
    command: process.execPath,
    args: [resolve('test/contract-agent.mjs')],
    maxWorkers: 2,
    idleMs: 60000,
  }),
);
await writeFile(
  telegramConfig,
  JSON.stringify({ chatId: -1009999, allowedUserIds: [42], workspaces: { main: workspace } }),
);
const telegramState = join(data, 'telegram', 'bot-123-chat--1009999.json');
const state = async () => JSON.parse(await readFile(telegramState, 'utf8'));
const env = {
  PI_TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  PI_TELEGRAM_API_BASE: apiBase,
  PI_TELEGRAM_PACE_MS: '1',
};
async function start(kind, historical) {
  const argv = [
    '--config',
    kind === 'session' ? sessionConfig : telegramConfig,
    '--data-dir',
    data,
  ];
  const executable = historical
    ? process.execPath
    : resolve(
        kind === 'session'
          ? 'service-dist/pi-acp-session-daemon'
          : 'rust/target/contract/debug/pi-acp-telegram-daemon',
      );
  if (historical)
    argv.unshift(
      ...(kind === 'telegram' ? ['--import', preload] : []),
      join(oldRoot, 'dist', `${kind}-daemon.mjs`),
    );
  const child = spawn(executable, argv, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-8000)));
  await until(
    () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`${kind} startup failed: ${errors}`);
      return output.includes('ready');
    },
    `${historical ? 'historical' : 'Rust'} ${kind} ready`,
  );
  return child;
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    await done;
    assert.equal(child.exitCode, 0, 'graceful shutdown failed');
  } finally {
    clearTimeout(timer);
  }
}
const check = (label) => {
  checks.push(label);
  console.log(`ok   ${label}`);
};
let service, relay, client;
try {
  service = await start('session', true);
  client = await ContractWire.open(join(data, 'service', 'sessions.sock'));
  const snapshot = await client.call('create', { cwd: workspace });
  const id = snapshot.id,
    params = {
      sessionId: id,
      prompt: [{ type: 'text', text: 'old-before-upgrade' }],
      source: 'desktop',
    };
  const originalResult = await client.call('prompt', params, 'rollback-original');
  for (const [method, args] of [
    ['session/set_config_option', { configId: 'model', value: 'other' }],
    ['session/set_mode', { modeId: 'high' }],
  ])
    await client.call('request', { sessionId: id, method, params: args });
  const removed = await client.call('create', { cwd: workspace });
  await client.call('remove', { sessionId: removed.id });
  relay = await start('telegram', true);
  message(`/open ${id}`);
  const binding = await until(
    async () => (await state()).topics.find((t) => t.sessionId === id),
    'historical binding',
  );
  await until(
    async () => (await state()).delivered.includes('service:rollback-original'),
    'historical outbox delivery',
  );
  message('/history', binding.threadId);
  await until(
    async () => (await state()).historySent?.[id]?.length,
    'historical history confirmation',
  );
  callback('silent:on', binding.threadId);
  await until(async () => (await state()).silent === true, 'historical silent setting');
  callback('notify:off', binding.threadId);
  await until(
    async () => (await state()).notifications === false,
    'historical notification setting',
  );
  callback('notify:on', binding.threadId);
  await until(
    async () => (await state()).notifications === true,
    'historical notification restore',
  );
  await stop(relay);
  await client.call(
    'prompt',
    { ...params, prompt: [{ type: 'text', text: 'old-offline-outbox' }] },
    'rollback-offline',
  );
  const oldSnapshot = (await client.call('state', { sessionId: id })).snapshot;
  client.close();
  await stop(service);
  // Adapter-owned native assets must survive service replacement byte-for-byte.
  await mkdir(join(data, 'adapter-state'));
  const nativeBytes =
    '{"type":"session","version":3,"id":"isolated-native","cwd":' +
    JSON.stringify(workspace) +
    '}\n';
  await writeFile(join(data, 'adapter-state', 'source.jsonl'), nativeBytes);
  await writeFile(
    join(data, 'adapter-state', 'session-map.json'),
    JSON.stringify({ version: 1, sessions: {} }),
  );
  await cp(data, backup, { recursive: true });
  const before = await inventory(backup),
    oldState = await state();
  const prefs = await readFile(join(data, 'preferences', 'pi.json'), 'utf8');
  check(
    'historical v0.9.4 produces history, tombstone, preferences, receipts, bindings, cursor, confirmations and offline outbox',
  );
  service = await start('session', false);
  client = await ContractWire.open(join(data, 'service', 'sessions.sock'));
  assert.deepEqual(
    (await client.call('state', { sessionId: id })).snapshot.entries,
    oldSnapshot.entries,
  );
  assert(!(await client.call('list')).some((s) => s.id === removed.id));
  assert.deepEqual(await client.call('prompt', params, 'rollback-original'), originalResult);
  assert.equal(await readFile(join(data, 'preferences', 'pi.json'), 'utf8'), prefs);
  assert.equal(
    sha(await readFile(join(data, 'service', 'requests', `${sha('rollback-original')}.json`))),
    before[`service/requests/${sha('rollback-original')}.json`],
  );
  check(
    'Rust reads old history/settings, preserves tombstone and reuses old receipt without replay',
  );
  relay = await start('telegram', false);
  await until(
    async () => (await state()).delivered.includes('service:rollback-offline'),
    'Rust old offline outbox',
  );
  const imported = await state();
  assert.deepEqual(imported.topics, oldState.topics);
  assert.deepEqual(imported.historySent, oldState.historySent);
  assert.equal(imported.silent, oldState.silent);
  assert.equal(imported.notifications, oldState.notifications);
  assert(imported.offset >= oldState.offset);
  assert.equal(
    sent.filter(
      (s) => s.method === 'sendMessage' && s.params.text?.includes('echo: old-offline-outbox'),
    ).length,
    1,
  );
  check(
    'Rust relay restores old binding/cursor/history confirmations/switches and delivers old outbox once',
  );
  await client.call(
    'prompt',
    { ...params, prompt: [{ type: 'text', text: 'new-after-upgrade' }] },
    'rollback-new',
  );
  await until(
    async () => (await state()).delivered.includes('service:rollback-new'),
    'new outbox confirmation',
  );
  await stop(relay);
  client.close();
  await stop(service);
  const upgraded = await inventory(data);
  for (const file of ['adapter-state/source.jsonl', 'adapter-state/session-map.json'])
    assert.equal(upgraded[file], before[file]);
  assert.deepEqual(await inventory(backup), before);
  await writeFile(join(reportDir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
  await writeFile(join(reportDir, 'upgraded.json'), JSON.stringify(upgraded, null, 2) + '\n');
  check(
    'upgrade creates new data while leaving versioned backup and adapter-owned native assets intact',
  );
  // Keep a copy of post-upgrade data for a separate reverse-compatibility check.
  const forwardCopy = join(root, 'forward-copy');
  await cp(data, forwardCopy, { recursive: true });
  await rm(data, { recursive: true });
  await cp(backup, data, { recursive: true });
  assert.deepEqual(await inventory(data), before);
  service = await start('session', true);
  client = await ContractWire.open(join(data, 'service', 'sessions.sock'));
  assert.deepEqual(
    (await client.call('state', { sessionId: id })).snapshot.entries,
    oldSnapshot.entries,
  );
  assert.deepEqual(await client.call('prompt', params, 'rollback-original'), originalResult);
  assert(!(await client.call('list')).some((s) => s.id === removed.id));
  assert.equal(await readFile(join(data, 'preferences', 'pi.json'), 'utf8'), prefs);
  const checkpoint = sent.length;
  relay = await start('telegram', true);
  await until(
    async () => (await state()).delivered.includes('service:rollback-offline'),
    'restored old outbox',
  );
  const restored = await state();
  assert.deepEqual(restored.topics, oldState.topics);
  assert.deepEqual(restored.historySent, oldState.historySent);
  assert.equal(restored.silent, oldState.silent);
  assert.equal(restored.notifications, oldState.notifications);
  assert(restored.offset >= oldState.offset);
  assert.equal(
    sent
      .slice(checkpoint)
      .filter(
        (s) => s.method === 'sendMessage' && s.params.text?.includes('echo: old-offline-outbox'),
      ).length,
    1,
  );
  await client.call('prompt', {
    ...params,
    prompt: [{ type: 'text', text: 'old-after-rollback' }],
  });
  assert(
    (await client.call('state', { sessionId: id })).snapshot.entries.some(
      (e) => e.text === 'echo: old-after-rollback',
    ),
  );
  check(
    'restored old release starts, preserves old data/receipts and accepts fresh work after rollback',
  );
  await stop(relay);
  client.close();
  await stop(service);
  // Also test the old reader against new-produced data, without weakening backup rollback.
  await rm(data, { recursive: true });
  await cp(forwardCopy, data, { recursive: true });
  service = await start('session', true);
  client = await ContractWire.open(join(data, 'service', 'sessions.sock'));
  assert(
    (await client.call('state', { sessionId: id })).snapshot.entries.some(
      (e) => e.text === 'echo: new-after-upgrade',
    ),
  );
  assert.deepEqual(
    await client.call(
      'prompt',
      { ...params, prompt: [{ type: 'text', text: 'new-after-upgrade' }] },
      'rollback-new',
    ),
    originalResult,
  );
  relay = await start('telegram', true);
  assert((await state()).delivered.includes('service:rollback-new'));
  check(
    'historical readers additionally accept new-written history, completed receipts and Telegram state',
  );
  await stop(relay);
  client.close();
  await stop(service);
  await writeFile(
    join(reportDir, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        baseline,
        commit,
        checks,
        backupFiles: Object.keys(before).length,
        mockBot: true,
        mockAcp: true,
        productionSession: true,
        testRelay: true,
        backupRestoredByteForByte: true,
        reversedNewDataRead: true,
        historicalDependencies: {
          sdk: oldPackage.dependencies['@agentclientprotocol/sdk'],
          lockfile: oldPackage.dependencies['proper-lockfile'],
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS isolated old -> new -> old rollback');
} catch (error) {
  await writeFile(
    join(reportDir, 'result.json'),
    JSON.stringify(
      { passed: false, baseline, commit, checks, error: String(error.stack || error) },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  client?.close();
  for (const child of children.reverse()) await stop(child);
  await new Promise((done) => api.close(done));
  await rm(root, { recursive: true, force: true });
}
