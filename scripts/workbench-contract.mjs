// New-daemon contract: real Unix IPC + independent stdio peer, no model/Bot credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import {
  operationRecords,
  imageArchive,
  assertStorageLayout,
} from './lib/workbench-sqlite-fixture.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);

const root = await mkdtemp(join(tmpdir(), 'workbench-contract-'));
const data = join(root, 'data');
const configFile = join(root, 'workbench.json');
const children = new Set();
let client;
const config = {
  workers: {
    pi: {
      command: process.execPath,
      args: [resolve('test/contract-agent.mjs')],
      env: {
        WORKBENCH_CONTRACT_CONFIG_GATE: join(root, 'config-gate'),
        WORKBENCH_CONTRACT_NATIVE_STATE: join(root, 'native-fixture'),
        WORKBENCH_CONTRACT_FORK_GATE: join(root, 'fork-gate'),
      },
    },
  },
  sessions: { mailbox: 128, max_workers: 16 },
  telegram: null,
  storage: { root: data },
  limits: { pending_interactions: 32 },
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let checks = 0;
function check(message) {
  checks++;
  console.log(`ok   ${message}`);
}
function launch(file = configFile, args = ['--config', file]) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.output = '';
  child.stdout.on('data', (bytes) => {
    child.output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    child.output += bytes;
  });
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return child;
}
async function start() {
  const child = launch();
  const deadline = Date.now() + 10000;
  while (!child.output.includes('ready:')) {
    if (child.exitCode !== null) throw new Error(child.output);
    if (Date.now() >= deadline) throw new Error(`daemon startup timeout: ${child.output}`);
    await delay(10);
  }
  return child;
}
async function stop(child) {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    assert.equal(await child.done, 0, child.output);
    assertStorageLayout(data);
  } finally {
    clearTimeout(timer);
  }
}
class Wire extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'event') return this.emit('event', message.event);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error')
        pending.reject(new Error(`${message.code}: ${message.message}`));
      else pending.resolve(message.type === 'image' ? message.asset : message.events);
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('IPC closed')));
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  static async open() {
    const socket = connect(join(data, 'workbench.sock'));
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new Wire(socket);
  }
  call(command, operation) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC timeout: ${command.method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ version: 2, id, command, operation }) + '\n');
    });
  }
  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (predicate(event)) {
          clearTimeout(timer);
          this.off('event', listener);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        this.off('event', listener);
        reject(new Error('domain event timeout'));
      }, 10000);
      this.on('event', listener);
    });
  }
  close() {
    this.socket.destroy();
  }
}
async function journal() {
  return operationRecords(data);
}
try {
  await writeFile(configFile, JSON.stringify(config));
  const help = launch(configFile, ['--help']);
  assert.equal(await help.done, 0);
  assert(help.output.includes('--config'));
  check('single daemon help exits without touching storage');
  let daemon = await start();
  client = await Wire.open();
  const createCommand = { method: 'create', harness: 'Pi', cwd: root };
  const created = await client.call(createCommand, 'contract-create');
  assert.deepEqual(await client.call(createCommand, 'contract-create'), created);
  await assert.rejects(client.call({ method: 'list' }, 'contract-create'), /operation_conflict/);
  const session = created[0].SessionCreated.id;
  assert(session);
  await client.call({ method: 'subscribe', session });
  check('external IPC creates and subscribes directly to the shared runtime');
  const textEvents = [];
  const liveRows = [];
  client.on('event', (event) => {
    if (event.AgentText) textEvents.push(event.AgentText.text);
    for (const kind of ['UserPromptAdded', 'AgentText', 'AgentThought', 'AgentImage']) {
      if (event[kind]) liveRows.push({ kind, ...event[kind] });
    }
  });
  const promptReceipts = [];
  for (const text of ['你好', 'second']) {
    const finished = client.waitFor((event) => event.TurnFinished);
    promptReceipts.push(
      await client.call(
        { method: 'prompt', session, prompt: text },
        `contract-prompt-${promptReceipts.length}`,
      ),
    );
    await finished;
  }
  assert.deepEqual(textEvents, ['echo: 你好', 'echo: second']);
  check('typed ACP handshake and two consecutive prompts publish domain text');
  const interaction = client.waitFor((event) => event.InteractionRequested);
  await client.call({ method: 'prompt', session, prompt: 'permission' });
  const requested = (await interaction).InteractionRequested.interaction;
  const finished = client.waitFor((event) => event.TurnFinished);
  await client.call({
    method: 'answer',
    session,
    answer: { interaction: requested.id, response: { Text: 'yes' } },
  });
  await finished;
  check('permission travels ACP → domain → external IPC → typed ACP response');
  const toolEvent = client.waitFor(
    (event) =>
      event.ToolCallChanged?.tool.details.kind === 'Edit' &&
      event.ToolCallChanged.tool.status === 'Completed',
  );
  const toolsFinished = client.waitFor((event) => event.TurnFinished);
  await client.call({ method: 'prompt', session, prompt: 'tool-metadata' });
  const editEvent = (await toolEvent).ToolCallChanged.tool;
  await toolsFinished;
  assert.equal(editEvent.details.name, 'apply_patch');
  assert.equal(editEvent.details.content[0].Diff.new_text, 'after');
  assert.equal(editEvent.details.locations[0].line, 0);
  assert(!JSON.stringify(editEvent).includes('NOT_IN_DOMAIN'));
  check(
    'typed tool diffs, locations and patch semantics reach committed IPC events without raw input',
  );
  const imageEvent = client.waitFor((event) => event.AgentImage);
  const imageFinished = client.waitFor((event) => event.TurnFinished);
  await client.call({ method: 'prompt', session, prompt: 'image-output' });
  const image = (await imageEvent).AgentImage;
  await imageFinished;
  assert.equal(image.image.mime, 'image/png');
  assert(image.image.bytes > 0 && image.image.bytes <= 4 * 1024 * 1024);
  assert(!JSON.stringify(image).includes('iVBOR'));
  const imageRecord = imageArchive(data, image.image.id);
  assert.equal(imageRecord.image.sha256, image.image.sha256);
  check(
    'agent image bytes are archived before metadata-only IPC publication and never in snapshots',
  );
  const journalBeforeImageRead = await journal();
  const readImage = await client.call({ method: 'image', image: image.image });
  assert.deepEqual(readImage, imageRecord);
  await assert.rejects(
    client.call({ method: 'image', image: image.image }, 'do-not-journal-pixels'),
    /invalid_input/,
  );
  await assert.rejects(
    client.call({ method: 'image', image: { ...image.image, sha256: '0'.repeat(64) } }),
    /persistence/,
  );
  assert.deepEqual(await journal(), journalBeforeImageRead);
  check(
    'dedicated IPC image response verifies immutable bytes/hash, rejects durable operation IDs and never journals pixels',
  );
  const streamedFinished = client.waitFor((event) => event.TurnFinished);
  await client.call({ method: 'prompt', session, prompt: 'streamed-message' });
  const streamedTurn = (await streamedFinished).TurnFinished.turn;
  const before = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
  for (const event of liveRows) {
    const entry = before.transcript.entries.find((entry) => entry.id === event.entry);
    assert(entry, 'published entry must identify a committed transcript row');
    assert.equal(entry.message ?? null, event.message ?? null);
    assert.equal(entry.text, event.text ?? event.prompt ?? '');
    if (event.image) assert.deepEqual(entry.image, event.image);
    assert(!JSON.stringify(event).includes('iVBOR'));
  }
  const streamed = liveRows.filter(
    (row) => row.turn === streamedTurn && row.kind !== 'UserPromptAdded',
  );
  assert.equal(streamed.length, 3);
  assert.equal(new Set(streamed.map((row) => row.entry)).size, 3);
  assert.equal(new Set(streamed.map((row) => row.message)).size, 1);
  assert(streamed[0].message);
  check(
    'live user/text/thought/image events identify immutable committed delta rows and opaque groups without merging or native timestamp guesses',
  );
  assert(!JSON.stringify(before).includes('iVBOR'));
  assert(before.provider_session);
  const duplicate = launch();
  assert.notEqual(await duplicate.done, 0);
  assert(duplicate.output.includes('another workbench host'));
  check('a second host refuses the same data directory');
  client.close();
  await stop(daemon);
  await assert.rejects(stat(join(data, 'workbench.sock')), { code: 'ENOENT' });
  daemon = await start();
  client = await Wire.open();
  const listed = (await client.call({ method: 'list' }))[0].SessionsListed;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].provider_session, before.provider_session);
  assert.deepEqual(await client.call(createCommand, 'contract-create'), created);
  assert.deepEqual(
    await client.call({ method: 'prompt', session, prompt: '你好' }, 'contract-prompt-0'),
    promptReceipts[0],
  );
  assert.equal((await client.call({ method: 'list' }))[0].SessionsListed.length, 1);
  check(
    'durable operation IDs replay original receipts across restart without rerunning create or prompt',
  );
  await client.call({ method: 'load', session });
  const loaded = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
  assert.deepEqual(loaded.transcript, before.transcript);
  assert.deepEqual(imageArchive(data, image.image.id), imageRecord);
  check('SIGTERM joins adapters, removes its socket and preserves versioned history');
  await client.call({ method: 'subscribe', session });
  const resumed = client.waitFor((event) => event.TurnFinished);
  await client.call({ method: 'prompt', session, prompt: 'resumed' });
  await resumed;
  const after = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
  assert.equal(after.provider_session, before.provider_session);
  assert.equal(after.transcript.entries.length, before.transcript.entries.length + 2);
  check('restart resumes the native provider session without replaying history');
  const forkCommand = {
    method: 'fork',
    session,
    request: { entry: after.transcript.entries[0].id },
  };
  await writeFile(join(root, 'fork-gate.release'), 'release');
  const forkReceipt = await client.call(forkCommand, 'contract-native-fork');
  const branch = forkReceipt[0].SessionCreated;
  assert.notEqual(branch.id, session);
  assert.notEqual(branch.provider_session, after.provider_session);
  assert.equal(branch.transcript.entries.length, 1);
  assert.equal(branch.transcript.origin.session, session);
  assert.deepEqual((await client.call({ method: 'inspect', session }))[0].SessionLoaded, after);
  await client.call({ method: 'remove', session });
  await assert.rejects(client.call({ method: 'inspect', session }), /not_found/);
  assert.equal((await client.call({ method: 'list' }))[0].SessionsListed.length, 1);
  assert.deepEqual(
    imageArchive(data, image.image.id),
    imageRecord,
    'immutable image survives source removal for pending delivery/history references',
  );
  assert.deepEqual(await client.call({ method: 'image', image: image.image }), readImage);
  check('removal drains the actor and deletes its history');
  client.close();
  await stop(daemon);
  daemon = await start();
  client = await Wire.open();
  assert.deepEqual(await client.call(forkCommand, 'contract-native-fork'), forkReceipt);
  assert.deepEqual(await client.call({ method: 'image', image: image.image }), readImage);
  await client.call({ method: 'load', session: branch.id });
  await client.call({ method: 'subscribe', session: branch.id });
  const branchFinished = client.waitFor((event) => event.TurnFinished?.session === branch.id);
  await client.call({
    method: 'prompt',
    session: branch.id,
    prompt: 'native branch after restart',
  });
  await branchFinished;
  const branchAfter = (await client.call({ method: 'inspect', session: branch.id }))[0]
    .SessionLoaded;
  assert.equal(branchAfter.provider_session, branch.provider_session);
  assert.equal(branchAfter.transcript.entries.length, 3);
  assert.equal(branchAfter.catalogue.current_model, 'default');
  assert.equal(branchAfter.config.model, null);
  check(
    'typed native fork preserves the source, resumes its independent prefix and replays after source removal/restart',
  );
  await rm(join(root, 'fork-gate.release'));
  await rm(join(root, 'fork-gate.started'));
  const cancelledFork = {
    method: 'fork',
    session: branch.id,
    request: { entry: branchAfter.transcript.entries[0].id },
  };
  const forkOutcome = client.call(cancelledFork, 'contract-cancelled-fork').then(
    (receipt) => ({ receipt }),
    (error) => ({ error }),
  );
  const forkDeadline = Date.now() + 5000;
  while (!(await stat(join(root, 'fork-gate.started')).catch(() => null))) {
    assert.ok(Date.now() < forkDeadline, 'native fork did not reach its independent peer');
    await delay(5);
  }
  await assert.rejects(
    client.call({ method: 'cancel_fork', session: branch.id, operation: 'not-this-fork' }),
    /fork_not_running/,
  );
  const cancelFork = {
    method: 'cancel_fork',
    session: branch.id,
    operation: 'contract-cancelled-fork',
  };
  await assert.rejects(
    client.call(cancelFork, 'contract-fork-cancel-request'),
    /native_fork_uncertain/,
  );
  assert.match((await forkOutcome).error.message, /native_fork_uncertain/);
  assert.deepEqual(
    (await client.call({ method: 'inspect', session: branch.id }))[0].SessionLoaded,
    branchAfter,
  );
  await assert.rejects(
    client.call(cancelledFork, 'contract-cancelled-fork'),
    /native_fork_uncertain/,
  );
  await assert.rejects(
    client.call(cancelFork, 'contract-fork-cancel-request'),
    /native_fork_uncertain/,
  );
  const afterCancellation = client.waitFor((event) => event.TurnFinished?.session === branch.id);
  await client.call({
    method: 'prompt',
    session: branch.id,
    prompt: 'source after fork cancellation',
  });
  await afterCancellation;
  await client.call({ method: 'remove', session: branch.id });
  assert.deepEqual((await client.call({ method: 'list' }))[0].SessionsListed, []);
  check(
    'operation-scoped fork cancellation uses the same IPC stream, preserves source and replays uncertainty without repeating effects',
  );
  const blockedSession = (await client.call(createCommand))[0].SessionCreated.id;
  const independentSession = (await client.call(createCommand))[0].SessionCreated.id;
  await client.call({ method: 'subscribe', session: blockedSession });
  await client.call({ method: 'subscribe', session: independentSession });
  const primed = client.waitFor((event) => event.TurnFinished?.session === blockedSession);
  await client.call({ method: 'prompt', session: blockedSession, prompt: 'prime catalogue' });
  await primed;
  const settingCommand = { method: 'set_model', session: blockedSession, model: 'other' };
  const blocked = client.call(settingCommand, 'contract-blocked-setting');
  blocked.catch(() => {});
  const gate = join(root, 'config-gate');
  const gateDeadline = Date.now() + 5000;
  while (!(await stat(`${gate}.started`).catch(() => null))) {
    assert(Date.now() < gateDeadline, 'provider did not enter configuration gate');
    await delay(5);
  }
  const requestedIndependent = client.waitFor(
    (event) => event.InteractionRequested?.session === independentSession,
  );
  await client.call({ method: 'prompt', session: independentSession, prompt: 'permission' });
  const independentInteraction = (await requestedIndependent).InteractionRequested.interaction;
  check(
    'blocked provider settings do not stall another session or subscription events on the same IPC stream',
  );
  const queued = Array.from({ length: 15 }, (_, index) => {
    const result = client.call(
      { method: 'set_mode', session: blockedSession, mode: 'high' },
      `contract-queued-mode-${index}`,
    );
    result.catch(() => {});
    return result;
  });
  await assert.rejects(client.call(createCommand), /backpressure/);
  const pending = (await client.call({ method: 'inspect', session: blockedSession }))[0]
    .SessionLoaded;
  assert(pending.configuration_intent);
  assert.equal((await client.call({ method: 'list' }))[0].SessionsListed.length, 2);
  const independentFinished = client.waitFor(
    (event) => event.TurnFinished?.session === independentSession,
  );
  await client.call({
    method: 'answer',
    session: independentSession,
    answer: { interaction: independentInteraction.id, response: { Text: 'yes' } },
  });
  await independentFinished;
  check('ordinary IPC saturation preserves query and answer reserves and rejects excess admission');
  await writeFile(`${gate}.release`, 'release');
  const originalSettingReceipt = await blocked;
  await Promise.all(queued);
  assert.deepEqual(
    await client.call(settingCommand, 'contract-blocked-setting'),
    originalSettingReceipt,
  );
  const configured = (await client.call({ method: 'inspect', session: blockedSession }))[0]
    .SessionLoaded;
  assert.equal(configured.config.model, 'other');
  assert.equal(configured.config.mode, 'high');
  assert.equal(configured.configuration_intent, undefined);
  await client.call({ method: 'remove', session: blockedSession });
  await client.call({ method: 'remove', session: independentSession });
  assert.deepEqual((await client.call({ method: 'list' }))[0].SessionsListed, []);
  check('provider release preserves per-session FIFO and immutable durable IPC receipts');
  client.close();
  await stop(daemon);
  const legacy = join(root, 'legacy');
  await mkdir(legacy);
  await writeFile(join(legacy, 'history-index.json'), 'legacy data');
  const oldConfig = join(root, 'legacy.json');
  await writeFile(oldConfig, JSON.stringify({ ...config, storage: { root: legacy } }));
  const rejected = launch(oldConfig);
  assert.notEqual(await rejected.done, 0);
  assert(rejected.output.includes('unversioned storage'));
  check('old unversioned storage is rejected, never implicitly migrated');
  console.log(`\n${checks} new-workbench daemon contract checks passed`);
} finally {
  client?.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.done));
  await rm(root, { recursive: true, force: true });
}
