// Real v3 Unix IPC + independent stdio peer; no model/Bot credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { WorkbenchWire, turnFinished, inlineText } from '../test/helpers/workbench-wire.mjs';
import {
  operationRecords,
  imageArchive,
  assertStorageLayout,
} from './lib/workbench-sqlite-fixture.mjs';
const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);
const root = await mkdtemp(join(tmpdir(), 'workbench-contract-'));
const data = join(root, 'data'),
  configFile = join(root, 'workbench.json'),
  children = new Set();
let client,
  checks = 0;
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
function check(message) {
  checks++;
  console.log(`ok   ${message}`);
}
function launch(file = configFile, args = ['--config', file]) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.output = '';
  child.stdout.on('data', (bytes) => (child.output += bytes));
  child.stderr.on('data', (bytes) => (child.output += bytes));
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
  const child = launch(),
    deadline = Date.now() + 10000;
  while (!child.output.includes('ready:')) {
    if (child.exitCode !== null) throw new Error(child.output);
    assert(Date.now() < deadline, child.output);
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
async function open() {
  client = await WorkbenchWire.open(join(data, 'workbench.sock'));
}
async function history(session) {
  return (await client.call({ method: 'history', session, limit: 200 })).entries;
}
async function inspect(session) {
  return client.call({ method: 'inspect', session });
}
async function prompt(session, text, operation) {
  const done = client.waitFor((batch) => turnFinished(batch, session));
  const receipt = await client.call(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: text }] } },
    operation,
  );
  const batch = await done;
  return { receipt, batch };
}
async function marker(path) {
  const deadline = Date.now() + 5000;
  while (!(await stat(path).catch(() => null))) {
    assert(Date.now() < deadline, `peer marker absent: ${path}`);
    await delay(5);
  }
}
try {
  await writeFile(configFile, JSON.stringify(config));
  const help = launch(configFile, ['--help']);
  assert.equal(await help.done, 0);
  assert(help.output.includes('--config'));
  check('single daemon help exits without touching storage');
  let daemon = await start();
  await open();
  const createCommand = { method: 'create', harness: 'Pi', cwd: root };
  const created = await client.call(createCommand, 'contract-create'),
    session = created.Created.summary.id;
  assert.deepEqual(await client.call(createCommand, 'contract-create'), created);
  await assert.rejects(
    client.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'conflict' }] } },
      'contract-create',
    ),
    /operation_conflict/,
  );
  const attached = await client.call({ method: 'attach', session });
  assert.equal(attached.view.id, session);
  assert.deepEqual(attached.recent_page.entries, []);
  check('v3 mutation summaries and atomic attach are separate bounded contracts');
  const liveRows = [],
    revisions = [],
    textEvents = [];
  client.on('batch', (batch) => {
    if (batch.session === session) {
      revisions.push(batch.revision);
      for (const row of batch.entries) {
        liveRows.push(row);
        if (row.role === 'Agent' && inlineText(row)) textEvents.push(inlineText(row));
      }
    }
  });
  const promptReceipts = [];
  for (const text of ['你好', 'second'])
    promptReceipts.push(
      (await prompt(session, text, `contract-prompt-${promptReceipts.length}`)).receipt,
    );
  assert.deepEqual(textEvents, ['echo: 你好', 'echo: second']);
  check('typed ACP handshake and two consecutive prompts publish committed headers');
  const requested = client.waitFor(
    (batch) =>
      batch.session === session && Object.keys(batch.view?.pending_interactions || {}).length,
  );
  await client.call({
    method: 'prompt',
    session,
    prompt: { parts: [{ type: 'text', text: 'permission' }] },
  });
  const interaction = Object.values((await requested).view.pending_interactions)[0];
  const answered = client.waitFor((batch) => turnFinished(batch, session));
  await client.call({
    method: 'answer',
    session,
    answer: { interaction: interaction.id, response: { Text: 'yes' } },
  });
  await answered;
  check('permission travels ACP → committed view → IPC → canonical typed ACP answer');
  const tools = client.waitFor((batch) =>
    batch.tools.some((tool) => tool.kind === 'Edit' && tool.status === 'Completed'),
  );
  const toolDone = prompt(session, 'tool-metadata');
  const edit = (await tools).tools.find((tool) => tool.kind === 'Edit');
  await toolDone;
  assert.equal(edit.name, 'apply_patch');
  assert.equal(edit.locations[0].line, 0);
  assert(!JSON.stringify(edit).includes('NOT_IN_DOMAIN'));
  const diff = await client.call({
    method: 'content',
    ref: edit.content[0].Diff.new_text,
    offset: 0,
  });
  assert.equal(diff.text, 'after');
  const toolPage = await client.call({ method: 'tools', session, turn: edit.turn });
  assert.deepEqual(
    toolPage.tools.find((tool) => tool.id === edit.id),
    edit,
  );
  check('tool patches carry bounded headers and explicit content refs, never raw input');
  const imageBatch = client.waitFor((batch) => batch.entries.some((row) => row.image));
  const imageDone = prompt(session, 'image-output');
  const image = (await imageBatch).entries.find((row) => row.image);
  await imageDone;
  assert.equal(image.image.mime, 'image/png');
  assert(image.image.bytes > 0 && image.image.bytes <= 4 * 1024 * 1024);
  assert(!JSON.stringify(image).includes('iVBOR'));
  const imageRecord = imageArchive(data, image.image.id);
  assert.equal(imageRecord.image.sha256, image.image.sha256);
  check('image archive commits before metadata publication without embedding pixels');
  const journalBeforeImageRead = operationRecords(data),
    readImage = await client.call({ method: 'image', image: image.image });
  assert.deepEqual(readImage, imageRecord);
  await assert.rejects(
    client.call({ method: 'image', image: image.image }, 'do-not-journal-pixels'),
    /invalid_input/,
  );
  await assert.rejects(
    client.call({ method: 'image', image: { ...image.image, sha256: '0'.repeat(64) } }),
    /persistence/,
  );
  assert.deepEqual(operationRecords(data), journalBeforeImageRead);
  check('image queries validate full identity and cannot enter the operation journal');
  const streamed = await prompt(session, 'streamed-message');
  let before = await inspect(session),
    beforePage = await history(session);
  for (const row of liveRows) {
    assert.deepEqual(
      beforePage.find((entry) => entry.id === row.id),
      row,
    );
    assert(!JSON.stringify(row).includes('iVBOR'));
  }
  const deltas = liveRows.filter((row) => row.turn === streamed.batch.view?.active_turn); // Finished view intentionally has no active turn.
  assert.equal(deltas.length, 0);
  const streamTurn = beforePage.at(-1).turn,
    streamedRows = liveRows.filter((row) => row.turn === streamTurn && row.role !== 'User');
  assert.equal(streamedRows.length, 3);
  assert.equal(new Set(streamedRows.map((row) => row.id)).size, 3);
  assert.equal(new Set(streamedRows.map((row) => row.message)).size, 1);
  assert(streamedRows[0].message);
  for (let i = 1; i < revisions.length; i++) assert.equal(revisions[i], revisions[i - 1] + 1);
  check('one contiguous revision batch per commit preserves distinct immutable delta identities');
  const count = client.requests.filter((request) => request.command.method === 'inspect').length;
  for (let i = 0; i < 42; i++)
    await prompt(session, `${String(i).padStart(3, '0')}:` + 'x'.repeat(99996));
  assert.equal(
    client.requests.filter((request) => request.command.method === 'inspect').length,
    count,
  );
  before = await inspect(session);
  beforePage = await history(session);
  assert(before.last_entry_seq >= 84);
  assert(beforePage.some((row) => row.text.Archived));
  check('42 legal 100k prompts complete without full-history mutation receipts or polling');
  assert(!JSON.stringify(before).includes('iVBOR'));
  assert(before.provider_session);
  const duplicate = launch();
  assert.notEqual(await duplicate.done, 0);
  assert(duplicate.output.includes('another workbench host'));
  check('second host refuses an active storage lease');
  client.close();
  await stop(daemon);
  await assert.rejects(stat(join(data, 'workbench.sock')), { code: 'ENOENT' });
  daemon = await start();
  await open();
  const listed = await client.call({ method: 'list' });
  assert.equal(listed.sessions.length, 1);
  assert(!('provider_session' in listed.sessions[0]));
  assert.equal((await inspect(session)).provider_session, before.provider_session);
  assert.deepEqual(await client.call(createCommand, 'contract-create'), created);
  assert.deepEqual(
    await client.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: '你好' }] } },
      'contract-prompt-0',
    ),
    promptReceipts[0],
  );
  assert.equal((await client.call({ method: 'list' })).sessions.length, 1);
  check('durable v3 receipts replay across restart without repeating create or prompt');
  const restartAttach = await client.call({ method: 'attach', session });
  assert.equal(restartAttach.view.revision, before.revision);
  assert.deepEqual(await history(session), beforePage);
  await client.call({ method: 'load', session });
  assert.deepEqual(await history(session), beforePage);
  assert.deepEqual(imageArchive(data, image.image.id), imageRecord);
  check('SIGTERM joins providers and preserves immutable pages/archive for restart attach');
  await prompt(session, 'resumed');
  const after = await inspect(session),
    afterPage = await history(session);
  assert.equal(after.provider_session, before.provider_session);
  assert.equal(after.last_entry_seq, before.last_entry_seq + 2);
  check('restart attach continues native prompts beyond former full-snapshot size limits');
  const forkCommand = { method: 'fork', session, request: { entry: afterPage[0].id } };
  await writeFile(join(root, 'fork-gate.release'), 'release');
  const forkReceipt = await client.call(forkCommand, 'contract-native-fork'),
    branchId = forkReceipt.Forked.summary.id,
    branch = await inspect(branchId);
  assert.notEqual(branch.id, session);
  assert.notEqual(branch.provider_session, after.provider_session);
  assert.equal((await history(branch.id)).length, 1);
  assert.equal(branch.origin.session, session);
  assert.deepEqual(await inspect(session), after);
  assert.deepEqual(await history(session), afterPage);
  await client.call({ method: 'remove', session });
  await assert.rejects(inspect(session), /not_found|query target not found/);
  assert.equal((await client.call({ method: 'list' })).sessions.length, 1);
  assert.deepEqual(imageArchive(data, image.image.id), imageRecord);
  assert.deepEqual(await client.call({ method: 'image', image: image.image }), readImage);
  check(
    'terminal removal drains the actor, keeps immutable archive and leaves only the independent branch',
  );
  client.close();
  await stop(daemon);
  daemon = await start();
  await open();
  assert.deepEqual(await client.call(forkCommand, 'contract-native-fork'), forkReceipt);
  assert.deepEqual(await client.call({ method: 'image', image: image.image }), readImage);
  await client.call({ method: 'load', session: branch.id });
  await client.call({ method: 'attach', session: branch.id });
  await prompt(branch.id, 'native branch after restart');
  const branchAfter = await inspect(branch.id),
    branchPage = await history(branch.id);
  assert.equal(branchAfter.provider_session, branch.provider_session);
  assert.equal(branchPage.length, 3);
  assert.equal(branchAfter.catalogue.current_model, 'default');
  assert.equal(branchAfter.config.model, null);
  check('one-worker fork resumes its native prefix and replays after source removal/restart');
  await rm(join(root, 'fork-gate.release'));
  await rm(join(root, 'fork-gate.started'));
  const cancelledFork = {
    method: 'fork',
    session: branch.id,
    request: { entry: branchPage[0].id },
  };
  const forkOutcome = client.call(cancelledFork, 'contract-cancelled-fork').then(
    (receipt) => ({ receipt }),
    (error) => ({ error }),
  );
  await marker(join(root, 'fork-gate.started'));
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
  assert.deepEqual(await inspect(branch.id), branchAfter);
  assert.deepEqual(await history(branch.id), branchPage);
  await assert.rejects(
    client.call(cancelledFork, 'contract-cancelled-fork'),
    /native_fork_uncertain/,
  );
  await assert.rejects(
    client.call(cancelFork, 'contract-fork-cancel-request'),
    /native_fork_uncertain/,
  );
  await prompt(branch.id, 'source after fork cancellation');
  await client.call({ method: 'remove', session: branch.id });
  assert.deepEqual((await client.call({ method: 'list' })).sessions, []);
  check(
    'operation-scoped fork cancel preserves source and replays uncertainty without repeating native effects',
  );
  const blockedSession = (await client.call(createCommand)).Created.summary.id,
    independentSession = (await client.call(createCommand)).Created.summary.id;
  await client.call({ method: 'attach', session: blockedSession });
  await client.call({ method: 'attach', session: independentSession });
  await prompt(blockedSession, 'prime catalogue');
  const settingCommand = { method: 'set_model', session: blockedSession, model: 'other' };
  const blocked = client.call(settingCommand, 'contract-blocked-setting');
  blocked.catch(() => {});
  const gate = join(root, 'config-gate');
  await marker(`${gate}.started`);
  const independentRequested = client.waitFor(
    (batch) =>
      batch.session === independentSession &&
      Object.keys(batch.view?.pending_interactions || {}).length,
  );
  await client.call({
    method: 'prompt',
    session: independentSession,
    prompt: { parts: [{ type: 'text', text: 'permission' }] },
  });
  const independentInteraction = Object.values(
    (await independentRequested).view.pending_interactions,
  )[0];
  check(
    'blocked provider setting does not stall independent session batches on the same connection',
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
  assert((await inspect(blockedSession)).configuration_intent);
  assert.equal((await client.call({ method: 'list' })).sessions.length, 2);
  const independentFinished = client.waitFor((batch) => turnFinished(batch, independentSession));
  await client.call({
    method: 'answer',
    session: independentSession,
    answer: { interaction: independentInteraction.id, response: { Text: 'yes' } },
  });
  await independentFinished;
  check('saturated ordinary admission preserves query and answer reserves');
  await writeFile(`${gate}.release`, 'release');
  const originalSettingReceipt = await blocked;
  await Promise.all(queued);
  assert.deepEqual(
    await client.call(settingCommand, 'contract-blocked-setting'),
    originalSettingReceipt,
  );
  const configured = await inspect(blockedSession);
  assert.equal(configured.config.model, 'other');
  assert.equal(configured.config.mode, 'high');
  assert.equal(configured.configuration_intent, null);
  await client.call({ method: 'remove', session: blockedSession });
  await client.call({ method: 'remove', session: independentSession });
  assert.deepEqual((await client.call({ method: 'list' })).sessions, []);
  check('provider release preserves per-session FIFO and original durable receipts');
  const noOpSession = (await client.call(createCommand)).Created.summary.id;
  await client.call({ method: 'attach', session: noOpSession });
  const noOpBatches = [];
  const collectNoOp = (batch) => {
    if (batch.session === noOpSession) noOpBatches.push(batch);
  };
  client.on('batch', collectNoOp);
  const noOpReceipts = [];
  for (const [method, key, value] of [
    ['set_model', 'model', 'default'],
    ['set_mode', 'mode', 'high'],
  ]) {
    const command = { method, session: noOpSession, [key]: value };
    await client.call(command);
    const revision = (await inspect(noOpSession)).revision;
    noOpBatches.length = 0;
    for (let index = 0; index < 2; index++) {
      const operation = `contract-noop-${method}-${index}`;
      const receipt = await client.call(command, operation);
      assert.equal((await client.call({ method: 'operation', operation })).status, 'completed');
      assert.equal((await inspect(noOpSession)).revision, revision);
      assert.equal(noOpBatches.length, 0);
      noOpReceipts.push({ operation, command, receipt });
    }
  }
  client.off('batch', collectNoOp);
  await client.call({ method: 'remove', session: noOpSession });
  client.close();
  await stop(daemon);
  daemon = await start();
  await open();
  for (const { operation, command, receipt } of noOpReceipts) {
    assert.deepEqual(await client.call(command, operation), receipt);
    assert.equal((await client.call({ method: 'operation', operation })).status, 'completed');
    await assert.rejects(
      client.call(
        { ...command, [command.method === 'set_model' ? 'model' : 'mode']: 'different' },
        operation,
      ),
      /operation_conflict/,
    );
  }
  check(
    'cold same-value model/mode seal terminal receipts without batches/revisions and replay after removal/restart',
  );
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
  console.log(`\n${checks} v3 workbench daemon contract checks passed`);
} finally {
  client?.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.done));
  await rm(root, { recursive: true, force: true });
}
