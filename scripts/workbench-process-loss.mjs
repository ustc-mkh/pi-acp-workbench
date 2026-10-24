// Actual SIGKILL/restart acceptance with isolated synthetic peers, not a soak
// or universal provider-process cleanup claim. Production refuses stale socket
// paths; only this fixture explicitly removes its own dead host's exact inode.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, lstat, unlink, rm, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchWire, turnFinished, inlineText } from '../test/helpers/workbench-wire.mjs';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { operationRecords, sessionRecord } from './lib/workbench-sqlite-fixture.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);

const root = await mkdtemp(join(tmpdir(), 'workbench-process-loss-'));
const peer = resolve('test/contract-agent.mjs');
const evidence = resolve('.test-results', `process-loss-v2-${randomUUID()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const digestFile = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const report = {
  version: 2,
  binary_sha256: await digestFile(binary),
  fixture_sha256: await digestFile(peer),
  scope:
    'Actual isolated host SIGKILL with synthetic providers; explicit transaction/reply/join cuts, not all P6 windows or online providers.',
  windows: [],
  hosts: [],
  passed: false,
};
const children = new Set();
const workerTraces = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`process-loss fixture timeout: ${label}`);
}
function launch(config, home, extraEnv = {}) {
  const child = spawn(binary, ['--config', config], {
    // No inherited provider/Bot keys, NODE_OPTIONS, account config or proxies.
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.output = '';
  child.stdout.on('data', (bytes) => {
    child.output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    child.output += bytes;
  });
  child.done = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      report.hosts.push({ pid: child.pid, code, signal, output: child.output });
      children.delete(child);
      child.closed = true;
      done({ code, signal });
    });
  });
  return child;
}
async function ready(child) {
  await until(() => {
    if (child.closed) throw new Error(`host failed startup: ${child.output}`);
    return child.output.includes('ready:');
  }, 'host ready');
}
async function stop(child) {
  if (child.closed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    assert.deepEqual(await child.done, { code: 0, signal: null }, child.output);
  } finally {
    clearTimeout(timer);
  }
}
async function traces(path) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function exited(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
  } catch (error) {
    // Linux may remove the task after opening /proc/<pid>/stat but before
    // read completes. ESRCH, like ENOENT, proves this PID is no longer live.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
    throw error;
  }
}
let client, httpServer;
async function deliveryAckWindow() {
  const directory = join(root, 'telegram'),
    data = join(directory, 'data'),
    home = join(directory, 'home');
  await mkdir(home, { recursive: true });
  const trace = join(directory, 'trace.ndjson');
  workerTraces.push(trace);
  const config = join(directory, 'workbench.json'),
    socket = join(data, 'workbench.sock');
  const configuration = {
    workers: {
      pi: { command: process.execPath, args: [peer], env: { WORKBENCH_CONTRACT_TRACE: trace } },
    },
    sessions: { mailbox: 128, max_workers: 1 },
    telegram: null,
    storage: { root: data },
    limits: { pending_interactions: 32 },
  };
  await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
  let host = launch(config, home);
  await ready(host);
  client = await WorkbenchWire.open(socket);
  const session = (await client.call({ method: 'create', harness: 'Pi', cwd: directory })).Created
    .summary.id;
  await client.call({ method: 'attach', session });
  const operation = 'delivery-agent-once';
  const prompt = {
    method: 'prompt',
    session,
    prompt: { parts: [{ type: 'text', text: 'billed-once' }] },
  };
  const finished = client.waitFor((batch) => turnFinished(batch, session));
  const receipt = await client.call(prompt, operation);
  await finished;
  client.close();
  client = undefined;
  await stop(host);
  const originalTrace = await readFile(trace);
  // Seed one test-owned delivery to the existing immutable Agent body, only
  // after a normal stop. The real scheduler/HTTP/ack path runs below.
  const database = new DatabaseSync(join(data, 'workbench.sqlite3'));
  const delivery = 'http-success-before-local-ack';
  try {
    database.exec('BEGIN IMMEDIATE');
    const entry = database
      .prepare(
        "SELECT e.metadata_json FROM session_entries s JOIN entries e ON e.entry_id=s.entry_id WHERE s.session=? AND e.role='Agent' ORDER BY s.seq LIMIT 1",
      )
      .get(session);
    const content = JSON.parse(entry.metadata_json).text;
    const order =
      database.prepare("SELECT value FROM store_meta WHERE key='delivery_seq'").get().value + 1;
    // Bootstrap Session-target rows have no Telegram binding. Settle only
    // these fixture rows while stopped, so unrelated ack transactions cannot
    // race the one intentionally write-locked window below.
    database.prepare("UPDATE deliveries SET status='Acked' WHERE status='Pending'").run();
    database.prepare("INSERT INTO telegram_meta VALUES(999,0,'999')").run();
    const target = { Telegram: { bot_id: 999, chat: -100, thread: 41, cwd: directory } };
    database
      .prepare(
        "INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status) VALUES(?,?,0,'telegram:999:-100:41',?,?,'Pending')",
      )
      .run(delivery, order, JSON.stringify(target), JSON.stringify({ Notice: { content } }));
    database.prepare("UPDATE store_meta SET value=? WHERE key='delivery_seq'").run(order);
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  let sends = 0,
    httpSucceeded = false,
    httpError;
  const sent = [];
  let releaseSend;
  const sendBarrier = new Promise((resolve) => {
    releaseSend = resolve;
  });
  report.delivery_http = { methods: [], sent };
  httpServer = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const method = request.url.split('/').at(-1);
      report.delivery_http.methods.push(method);
      let result;
      if (method === 'getMe') result = { id: 999, is_bot: true, username: 'crash_fixture' };
      else if (method === 'getUpdates') {
        await delay(50);
        result = [];
      } else if (method === 'sendMessage') {
        await sendBarrier;
        assert.equal(body.chat_id, -100);
        assert.equal(body.message_thread_id, 41);
        assert(body.text.includes('billed-once'));
        sent.push(body.text);
        sends++;
        if (sends === 1) {
          // The test service has accepted this request. Freeze only its own
          // known client host before returning HTTP success: local ack cannot
          // race the SIGKILL, and no unrelated SQLite writer is contended.
          host.kill('SIGSTOP');
        }
        result = { message_id: sends, chat: { id: -100 }, message_thread_id: 41, text: body.text };
      } else throw new Error(`unexpected method ${method}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, result }), () => {
        if (method === 'sendMessage' && sends === 1) httpSucceeded = true;
      });
    } catch (error) {
      httpError = error;
      report.delivery_http.error = String(error.stack || error);
      response.statusCode = 500;
      response.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  configuration.telegram = {
    bot_token_env: 'P6_FIXTURE_BOT_TOKEN',
    workspace: directory,
    allowed_chat_ids: [-100],
    allowed_user_ids: [5],
    api_base: `http://127.0.0.1:${httpServer.address().port}/`,
  };
  await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
  const env = { P6_FIXTURE_BOT_TOKEN: '999:PUBLIC_SYNTHETIC_FIXTURE' };
  host = launch(config, home, env);
  await ready(host);
  releaseSend();
  await until(() => {
    if (httpError) throw httpError;
    return httpSucceeded;
  }, 'HTTP success while the client host is frozen before ack');
  const hostStat = await readFile(`/proc/${host.pid}/stat`, 'utf8');
  assert(hostStat.slice(hostStat.lastIndexOf(')') + 2).startsWith('T '));
  const readDelivery = () => {
    const db = new DatabaseSync(join(data, 'workbench.sqlite3'), { readOnly: true });
    try {
      return db.prepare('SELECT status FROM deliveries WHERE delivery_id=?').get(delivery).status;
    } finally {
      db.close();
    }
  };
  assert.equal(readDelivery(), 'Pending');
  assert.equal(operationRecords(data, operation)[0].status, 'Completed');
  const inode = await lstat(socket);
  host.kill('SIGKILL');
  assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' });
  const stale = await lstat(socket);
  assert(stale.isSocket() && stale.ino === inode.ino && stale.dev === inode.dev);
  await unlink(socket);
  host = launch(config, home, env);
  await ready(host);
  client = await WorkbenchWire.open(socket);
  assert.deepEqual(await client.call(prompt, operation), receipt);
  await until(() => {
    if (httpError) throw httpError;
    return readDelivery() === 'Acked';
  }, 'original pending delivery is resent then durably acknowledged');
  assert.equal(sends, 2, 'at-least-once HTTP permits a duplicate after success without local ack');
  assert.equal(sent[0], sent[1]);
  assert.deepEqual(
    await readFile(trace),
    originalTrace,
    'outbox recovery/replay must not boot or rerun the Agent',
  );
  client.close();
  client = undefined;
  await stop(host);
  report.windows.push({
    provider: 'Telegram fixture HTTP',
    window: 'HTTP-success-client-frozen-before-local-ack',
    operation,
    delivery,
    successful_external_sends: sends,
    agent_prompts: 1,
    at: Date.now(),
  });
  console.log(
    'ok   Telegram: SIGKILL after successful HTTP/before ack; one external duplicate, one Agent execution, durable ack after restart',
  );
}
try {
  for (const [harness, name] of [
    ['Pi', 'pi'],
    ['Codex', 'codex'],
    ['Claude', 'claude'],
  ]) {
    const directory = join(root, name),
      home = join(directory, 'home'),
      data = join(directory, 'data');
    await mkdir(home, { recursive: true });
    execFileSync('git', ['init', '-q', directory]);
    await writeFile(join(directory, '.gitignore'), '*\n!review.txt\n');
    const workspaceFile = join(directory, 'review.txt');
    await writeFile(workspaceFile, 'before\n');
    const trace = join(directory, 'trace.ndjson');
    workerTraces.push(trace);
    const config = join(directory, 'workbench.json');
    await writeFile(
      config,
      JSON.stringify({
        workers: {
          [name]: {
            command: process.execPath,
            args: [peer, name],
            env: {
              WORKBENCH_CONTRACT_PROVIDER: name,
              WORKBENCH_CONTRACT_TYPED_SETTINGS: '1',
              WORKBENCH_CONTRACT_CONFIG_GATE: join(directory, 'configure-gate'),
              WORKBENCH_CONTRACT_WRITE_ON_PERMISSION: workspaceFile,
              WORKBENCH_CONTRACT_TRACE: trace,
              WORKBENCH_CONTRACT_NATIVE_STATE: join(directory, 'native'),
              WORKBENCH_CONTRACT_FORK_JOIN_GATE: join(directory, 'fork-join'),
            },
          },
        },
        sessions: { mailbox: 128, max_workers: 1 },
        telegram: null,
        storage: { root: data },
        limits: { pending_interactions: 32 },
      }),
    );
    let host = launch(config, home);
    await ready(host);
    const socket = join(data, 'workbench.sock');
    client = await WorkbenchWire.open(socket);
    const created = await client.call({ method: 'create', harness, cwd: directory });
    const session = created.Created.summary.id;
    await client.call({ method: 'attach', session });
    const noOpCommand = { method: 'set_model', session, model: 'default' };
    await client.call(noOpCommand);
    const noOpRevision = (await client.call({ method: 'inspect', session })).revision;
    const noOpOperation = `lost-noop-receipt-${name}`;
    // Deliberately do not install a response observer. Poll the durable commit
    // instead, then disconnect and later SIGKILL/restart the actual host.
    client.socket.write(
      JSON.stringify({ version: 3, id: 999999, command: noOpCommand, operation: noOpOperation }) +
        '\n',
    );
    await until(
      () => operationRecords(data, noOpOperation)[0]?.status === 'Completed',
      'no-op receipt commit',
    );
    client.close();
    client = await WorkbenchWire.open(socket);
    await client.call({ method: 'attach', session });
    assert.equal((await client.call({ method: 'inspect', session })).revision, noOpRevision);
    const noOpRows = operationRecords(data, noOpOperation);
    const noOpReceipt = JSON.parse(noOpRows[0].result.toString('utf8')).Ok;
    let finished = client.waitFor((batch) => turnFinished(batch, session));
    await client.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'image-output' }] } },
      `image-${name}`,
    );
    await finished;
    let snapshot = await client.call({ method: 'inspect', session });
    const image = (await client.call({ method: 'history', session })).entries.find(
      (entry) => entry.image,
    )?.image;
    assert(image, 'committed image fixture reference');
    const imageAsset = await client.call({ method: 'image', image });
    const operation = `accepted-before-kill-${name}`;
    const command = {
      method: 'prompt',
      session,
      prompt: { parts: [{ type: 'text', text: 'permission' }] },
    };
    const interaction = client.waitFor(
      (batch) =>
        batch.session === session && Object.keys(batch.view?.pending_interactions || {}).length,
    );
    const receipt = await client.call(command, operation);
    await interaction;
    snapshot = await client.call({ method: 'inspect', session });
    assert.equal(Object.keys(snapshot.pending_interactions).length, 1);
    assert.equal(await readFile(workspaceFile, 'utf8'), 'after\n');
    const interruptedTurn = snapshot.active_turn;
    assert(interruptedTurn);
    const native = snapshot.provider_session;
    assert(native);
    const sessionBeforeKill = sessionRecord(data, session);
    const receiptRows = operationRecords(data, operation);
    assert.equal(receiptRows.length, 1);
    assert.equal(receiptRows[0].status, 'Completed');
    assert.deepEqual(JSON.parse(receiptRows[0].result.toString('utf8')), { Ok: receipt });
    const inode = await lstat(socket);
    const worker = (await traces(trace)).find((entry) => entry.method === 'boot').pid;
    const traceBeforeKill = await readFile(trace);
    host.kill('SIGKILL');
    assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' });
    client.close();
    client = undefined;
    // This peer has no external network or timers while awaiting permission;
    // host pipe EOF lets it exit. This is not a guarantee for arbitrary agents.
    await until(() => exited(worker), 'synthetic peer exits on host pipe EOF');
    assert.deepEqual(
      sessionRecord(data, session),
      sessionBeforeKill,
      'SIGKILL preserves committed SQLite session bytes',
    );
    const refused = launch(config, home);
    const refusedResult = await refused.done;
    assert.notEqual(refusedResult.code, 0, 'stale socket must fail closed');
    const stale = await lstat(socket);
    assert(stale.isSocket() && stale.ino === inode.ino && stale.dev === inode.dev);
    assert.deepEqual(sessionRecord(data, session), sessionBeforeKill);
    // Explicit, test-owned operator cleanup, after real host death and inode
    // validation. No production startup/maintenance path silently unlinks it.
    await unlink(socket);
    host = launch(config, home);
    await ready(host);
    client = await WorkbenchWire.open(socket);
    assert.deepEqual(await client.call(noOpCommand, noOpOperation), noOpReceipt);
    assert.equal(
      (await client.call({ method: 'operation', operation: noOpOperation })).status,
      'completed',
    );
    assert.deepEqual(operationRecords(data, noOpOperation), noOpRows);
    const cold = await client.call({ method: 'inspect', session });
    assert.equal(cold.provider_session, native);
    assert.equal(Object.keys(cold.pending_interactions).length, 1);
    const missingDiff = await client.call({ method: 'turn_diff', session, turn: interruptedTurn });
    assert.equal(
      missingDiff.status,
      'unavailable',
      'host loss cannot fabricate a final workspace snapshot',
    );
    assert.equal(
      await readFile(workspaceFile, 'utf8'),
      'after\n',
      'restart must not undo or replay shell effects',
    );
    assert.deepEqual(
      await readFile(trace),
      traceBeforeKill,
      'cold inspect must not start a provider',
    );
    await client.call({ method: 'load', session });
    const recovered = await client.call({ method: 'inspect', session });
    assert.equal(recovered.provider_session, native);
    assert.equal(Object.keys(recovered.pending_interactions).length, 0);
    assert.equal(recovered.active_turn, null);
    assert.deepEqual(await client.call(command, operation), receipt);
    assert.deepEqual(
      await readFile(trace),
      traceBeforeKill,
      'load/replay must not repeat prompt or boot a worker',
    );
    assert.deepEqual(
      operationRecords(data, operation),
      receiptRows,
      'immutable raw SQL receipt survives SIGKILL/load/replay',
    );
    assert.deepEqual(await client.call({ method: 'image', image }), imageAsset);
    report.windows.push({
      provider: harness,
      window: 'committed-noop-and-accepted-prompt-before-receipt-observation',
      operation,
      noop_operation: noOpOperation,
      at: Date.now(),
    });
    await client.call({ method: 'attach', session });
    finished = client.waitFor((batch) => turnFinished(batch, session));
    await client.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'worker-profile' }] } },
      `explicit-after-kill-${name}`,
    );
    await finished;
    const after = await client.call({ method: 'inspect', session });
    assert.equal(after.provider_session, native);
    assert.equal(after.last_entry_seq, recovered.last_entry_seq + 2);
    assert.equal(
      inlineText((await client.call({ method: 'history', session })).entries.at(-1)),
      `${name}:${name}`,
    );
    const records = await traces(trace);
    assert.equal(
      records.filter((entry) => entry.method === 'session/prompt' && entry.text === 'permission')
        .length,
      1,
    );
    assert(records.some((entry) => entry.method === 'session/load' && entry.sessionId === native));
    // P2: remote configuration applied, but its reply/settlement is held.
    // Killing the actual host must retain the original uncertain identity;
    // cold recovery never resends the setting or saves it as a new default.
    const settingOperation = `uncertain-thinking-${name}`;
    const uncertain = client
      .call({ method: 'set_option', session, id: 'thought_level', value: 'high' }, settingOperation)
      .then(
        () => 'unexpected-success',
        () => 'disconnected',
      );
    await until(async () => {
      try {
        await lstat(join(directory, 'configure-gate.started'));
        return true;
      } catch {
        return false;
      }
    }, 'remote configure barrier');
    assert((await client.call({ method: 'inspect', session })).configuration_intent);
    const configureInode = await lstat(socket);
    host.kill('SIGKILL');
    await host.done;
    client.close();
    client = undefined;
    assert.equal(await uncertain, 'disconnected');
    // This deliberately gated fixture peer owns a timer. Explicitly clean only
    // its verified test process group, never claim arbitrary agent EOF cleanup.
    const configureWorker = (await traces(trace))
      .filter((entry) => entry.method === 'boot')
      .at(-1).pid;
    const workerEnv = await readFile(`/proc/${configureWorker}/environ`, 'utf8');
    assert(workerEnv.split('\0').includes(`WORKBENCH_CONTRACT_TRACE=${trace}`));
    process.kill(-configureWorker, 'SIGKILL');
    await until(() => exited(configureWorker), 'gated fixture peer cleanup');
    const configureStale = await lstat(socket);
    assert(
      configureStale.isSocket() &&
        configureStale.ino === configureInode.ino &&
        configureStale.dev === configureInode.dev,
    );
    await unlink(socket);
    host = launch(config, home);
    await ready(host);
    client = await WorkbenchWire.open(socket);
    const beforeRecovery = await readFile(trace, 'utf8');
    assert.equal(
      (await client.call({ method: 'operation', operation: settingOperation })).status,
      'uncertain',
    );
    assert((await client.call({ method: 'inspect', session })).configuration_intent);
    assert.equal(await readFile(trace, 'utf8'), beforeRecovery);
    await client.call({ method: 'discover', session });
    assert.equal((await client.call({ method: 'inspect', session })).configuration_intent, null);
    assert.equal(
      (await traces(trace)).filter(
        (entry) =>
          entry.method === 'session/set_config_option' &&
          entry.configId === 'thought_level' &&
          entry.value === 'high',
      ).length,
      1,
    );
    const newSession = (await client.call({ method: 'create', harness, cwd: directory })).Created
      .summary.id;
    assert.equal(
      (await client.call({ method: 'inspect', session: newSession })).config.options?.thought_level,
      undefined,
    );
    report.windows.push({
      provider: harness,
      window: 'remote-config-applied-before-reply',
      operation: settingOperation,
      at: Date.now(),
    });
    // Independent cut: allow the remote reply, while a test-owned SQLite write
    // lock prevents settlement. Kill before releasing it; recovery must query
    // this identity, never send the setting again or turn it into a default.
    await rm(join(directory, 'configure-gate.started'), { force: true });
    await rm(join(directory, 'configure-gate.release'), { force: true });
    const settleOperation = `remote-replied-before-settle-${name}`;
    const settleCommand = { method: 'set_option', session, id: 'thought_level', value: 'high' };
    const settling = client.call(settleCommand, settleOperation).then(
      () => 'unexpected-success',
      () => 'disconnected',
    );
    await until(async () => {
      try {
        await lstat(join(directory, 'configure-gate.started'));
        return true;
      } catch {
        return false;
      }
    }, 'prepare committed / remote setting held');
    const settleRows = operationRecords(data, settleOperation);
    assert.equal(settleRows[0].status, 'Started');
    const writeLock = new DatabaseSync(join(data, 'workbench.sqlite3'));
    try {
      writeLock.exec('BEGIN IMMEDIATE');
      const repliesBefore = (await traces(trace)).filter(
        (row) => row.method === 'fixture/config-replied',
      ).length;
      await writeFile(join(directory, 'configure-gate.release'), 'release');
      await until(
        async () =>
          (await traces(trace)).filter((row) => row.method === 'fixture/config-replied').length >
          repliesBefore,
        'remote configuration reply sent / settlement locked',
      );
      assert((await client.call({ method: 'inspect', session })).configuration_intent);
      assert.deepEqual(operationRecords(data, settleOperation), settleRows);
      const settleInode = await lstat(socket);
      const settleWorker = (await traces(trace)).filter((row) => row.method === 'boot').at(-1).pid;
      host.kill('SIGKILL');
      assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' });
      client.close();
      client = undefined;
      assert.equal(await settling, 'disconnected');
      await until(() => exited(settleWorker), 'settled-reply fixture EOF cleanup');
      const settleStale = await lstat(socket);
      assert(
        settleStale.isSocket() &&
          settleStale.ino === settleInode.ino &&
          settleStale.dev === settleInode.dev,
      );
      await unlink(socket);
    } finally {
      // Never release the write lock with a live host that could commit after
      // a failed assertion. Cleanup remains scoped to this fixture's child.
      if (!host.closed) {
        host.kill('SIGKILL');
        await host.done;
      }
      writeLock.exec('ROLLBACK');
      writeLock.close();
    }
    host = launch(config, home);
    await ready(host);
    client = await WorkbenchWire.open(socket);
    const beforeSettleReplay = await readFile(trace);
    assert.equal(
      (await client.call({ method: 'operation', operation: settleOperation })).status,
      'uncertain',
    );
    await assert.rejects(client.call(settleCommand, settleOperation), /operation_interrupted/);
    assert.deepEqual(await readFile(trace), beforeSettleReplay);
    assert.deepEqual(operationRecords(data, settleOperation), settleRows);
    await client.call({ method: 'discover', session });
    assert.equal((await client.call({ method: 'inspect', session })).configuration_intent, null);
    assert.equal(
      (await traces(trace)).filter(
        (row) =>
          row.method === 'session/set_config_option' &&
          row.configId === 'thought_level' &&
          row.value === 'high',
      ).length,
      2,
      'two explicit operations, no automatic remote resend',
    );
    console.log(
      `ok   ${harness}: remote configuration reply before locked settlement, SIGKILL and uncertain replay without resend`,
    );
    report.windows.push({
      provider: harness,
      window: 'remote-config-replied-before-locked-settlement',
      operation: settleOperation,
      at: Date.now(),
    });
    if (harness === 'Pi') {
      // Remote fork result has returned; stop_session_adapter is joining the
      // source worker, and adoption has not committed. The fixture freezes its
      // own known host parent on EOF, removing the scheduler race at this cut.
      const before = await client.call({ method: 'inspect', session });
      const entries = (await client.call({ method: 'history', session, limit: 200 })).entries;
      const entry = entries.find((row) => row.role === 'User');
      assert(entry);
      const nativeDirectory = join(directory, 'native');
      const sourcePath = join(nativeDirectory, `${before.provider_session}.json`);
      const digest = async (path) =>
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      const sourceHash = await digest(sourcePath);
      const nativeBefore = await readdir(nativeDirectory);
      const forkOperation = 'fork-returned-before-adoption';
      const forkCommand = { method: 'fork', session, request: { entry: entry.id } };
      const originalSource = sessionRecord(data, session);
      const originalSessions = (await client.call({ method: 'list', limit: 100 })).sessions
        .map((row) => row.id)
        .sort();
      await writeFile(join(directory, 'fork-join.armed'), 'armed');
      const fork = client.call(forkCommand, forkOperation).then(
        () => 'unexpected-success',
        () => 'disconnected',
      );
      await until(async () => {
        try {
          await lstat(join(directory, 'fork-join.started'));
          return true;
        } catch {
          return false;
        }
      }, 'confirmed fork result / source join / before adoption');
      const barrier = JSON.parse(await readFile(join(directory, 'fork-join.started'), 'utf8'));
      assert.equal(barrier.host, host.pid);
      const hostStat = await readFile(`/proc/${host.pid}/stat`, 'utf8');
      assert(
        hostStat.slice(hostStat.lastIndexOf(')') + 2).startsWith('T '),
        'host is frozen at join',
      );
      const branches = (await readdir(nativeDirectory)).filter(
        (file) => !nativeBefore.includes(file),
      );
      assert.equal(branches.length, 1, 'exactly one independently persisted native branch');
      const branchPath = join(nativeDirectory, branches[0]);
      const branchHash = await digest(branchPath);
      assert.equal(await digest(sourcePath), sourceHash, 'fork leaves source native bytes intact');
      assert.deepEqual(
        sessionRecord(data, session),
        originalSource,
        'source SQL unchanged before adoption',
      );
      assert.equal(operationRecords(data, forkOperation)[0].status, 'Started');
      const forkInode = await lstat(socket);
      host.kill('SIGKILL');
      assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' });
      client.close();
      client = undefined;
      assert.equal(await fork, 'disconnected');
      // Clean only this verified fixture worker; preserve its native files.
      const workerEnv = await readFile(`/proc/${barrier.worker}/environ`, 'utf8');
      assert(workerEnv.split('\0').includes(`WORKBENCH_CONTRACT_TRACE=${trace}`));
      process.kill(-barrier.worker, 'SIGKILL');
      await until(() => exited(barrier.worker), 'fork fixture join cleanup');
      const forkStale = await lstat(socket);
      assert(
        forkStale.isSocket() && forkStale.ino === forkInode.ino && forkStale.dev === forkInode.dev,
      );
      await unlink(socket);
      host = launch(config, home);
      await ready(host);
      client = await WorkbenchWire.open(socket);
      const traceBeforeReplay = await readFile(trace);
      assert.equal(
        (await client.call({ method: 'operation', operation: forkOperation })).status,
        'uncertain',
      );
      await assert.rejects(client.call(forkCommand, forkOperation), /operation_interrupted/);
      assert.deepEqual(
        (await client.call({ method: 'list', limit: 100 })).sessions.map((row) => row.id).sort(),
        originalSessions,
      );
      assert.deepEqual(sessionRecord(data, session), originalSource);
      assert.deepEqual(
        await readFile(trace),
        traceBeforeReplay,
        'cold recovery/replay must not start another native fork',
      );
      assert.equal(await digest(sourcePath), sourceHash);
      assert.equal(await digest(branchPath), branchHash, 'unadopted remote branch is preserved');
      report.windows.push({
        provider: harness,
        window: 'remote-fork-returned-source-join-before-adoption',
        operation: forkOperation,
        source_sha256: sourceHash,
        unadopted_branch_sha256: branchHash,
        barrier,
        at: Date.now(),
      });
      console.log(
        'ok   Pi: frozen post-result/pre-adoption SIGKILL, uncertain original operation, no branch adoption/retry or source mutation',
      );
    }
    client.close();
    client = undefined;
    await stop(host);
    console.log(
      `ok   ${harness}: real SIGKILL, stale-socket refusal, explicit fixture cleanup, cold recovery, immutable replay/image, same-native continuation and uncertain configure without resend/default poisoning`,
    );
  }
  await deliveryAckWindow();
  console.log(
    `3 provider profiles / ${report.windows.length} process-loss windows passed: ${evidence} (synthetic peers; no live model/Bot or automatic stale-socket recovery)`,
  );
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  throw error;
} finally {
  client?.close();
  for (const child of [...children]) {
    child.kill('SIGKILL');
    await child.done.catch(() => {});
  }
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  }
  // Only clean up provably fixture-owned process groups on a failed test.
  for (const trace of workerTraces) {
    for (const entry of await traces(trace).catch(() => [])) {
      if (entry.method !== 'boot') continue;
      try {
        const command = await readFile(`/proc/${entry.pid}/cmdline`, 'utf8');
        const env = await readFile(`/proc/${entry.pid}/environ`, 'utf8');
        if (command.includes(peer) && env.split('\0').includes(`WORKBENCH_CONTRACT_TRACE=${trace}`))
          process.kill(-entry.pid, 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
    }
  }
  for (const [index, trace] of workerTraces.entries()) {
    await writeFile(
      join(evidence, `${index}-provider.ndjson`),
      await readFile(trace).catch(() => ''),
      { mode: 0o600 },
    );
  }
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  await rm(root, { recursive: true, force: true });
}
