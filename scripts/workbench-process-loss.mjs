// Actual SIGKILL/restart acceptance with isolated synthetic peers, not a soak
// or universal provider-process cleanup claim. Production refuses stale socket
// paths; only this fixture explicitly removes its own dead host's exact inode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, lstat, unlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';

const root = await mkdtemp(join(tmpdir(), 'workbench-process-loss-'));
const binary = resolve('rust/target/debug/pi-acp-workbenchd');
const peer = resolve('test/contract-agent.mjs');
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
function launch(config, home) {
  const child = spawn(binary, ['--config', config], {
    // No inherited provider/Bot keys, NODE_OPTIONS, account config or proxies.
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' },
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
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
let client;
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
              WORKBENCH_CONTRACT_TRACE: trace,
              WORKBENCH_CONTRACT_NATIVE_STATE: join(directory, 'native'),
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
    const session = created.find((event) => event.SessionCreated).SessionCreated.id;
    await client.call({ method: 'subscribe', session });
    let finished = client.waitFor((event) => event.TurnFinished?.session === session);
    await client.call({ method: 'prompt', session, prompt: 'image-output' }, `image-${name}`);
    await finished;
    let snapshot = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    const image = snapshot.transcript.entries.find((entry) => entry.image)?.image;
    assert(image, 'committed image fixture reference');
    const imageAsset = await client.call({ method: 'image', image });
    const operation = `accepted-before-kill-${name}`;
    const command = { method: 'prompt', session, prompt: 'permission' };
    const interaction = client.waitFor((event) => event.InteractionRequested?.session === session);
    const receipt = await client.call(command, operation);
    await interaction;
    snapshot = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    assert.equal(Object.keys(snapshot.pending_interactions).length, 1);
    const native = snapshot.provider_session;
    assert(native);
    const historyPath = join(data, 'history', `${session}.json`);
    const history = await readFile(historyPath);
    const receipts = [
      join(data, 'journal', `${operation}.json`),
      join(data, 'journal/results', `${operation}.json`),
    ];
    const receiptBytes = await Promise.all(receipts.map((file) => readFile(file)));
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
    assert.deepEqual(await readFile(historyPath), history, 'no synthetic history restoration');
    const refused = launch(config, home);
    const refusedResult = await refused.done;
    assert.notEqual(refusedResult.code, 0, 'stale socket must fail closed');
    const stale = await lstat(socket);
    assert(stale.isSocket() && stale.ino === inode.ino && stale.dev === inode.dev);
    assert.deepEqual(await readFile(historyPath), history);
    // Explicit, test-owned operator cleanup, after real host death and inode
    // validation. No production startup/maintenance path silently unlinks it.
    await unlink(socket);
    host = launch(config, home);
    await ready(host);
    client = await WorkbenchWire.open(socket);
    const cold = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    assert.equal(cold.provider_session, native);
    assert.equal(Object.keys(cold.pending_interactions).length, 1);
    assert.deepEqual(
      await readFile(trace),
      traceBeforeKill,
      'cold inspect must not start a provider',
    );
    await client.call({ method: 'load', session });
    const recovered = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    assert.equal(recovered.provider_session, native);
    assert.equal(Object.keys(recovered.pending_interactions).length, 0);
    assert.equal(recovered.active_turn, null);
    assert.deepEqual(await client.call(command, operation), receipt);
    assert.deepEqual(
      await readFile(trace),
      traceBeforeKill,
      'load/replay must not repeat prompt or boot a worker',
    );
    for (let i = 0; i < receipts.length; i++)
      assert.deepEqual(await readFile(receipts[i]), receiptBytes[i]);
    assert.deepEqual(await client.call({ method: 'image', image }), imageAsset);
    await client.call({ method: 'subscribe', session });
    finished = client.waitFor((event) => event.TurnFinished?.session === session);
    await client.call(
      { method: 'prompt', session, prompt: 'worker-profile' },
      `explicit-after-kill-${name}`,
    );
    await finished;
    const after = (await client.call({ method: 'inspect', session }))[0].SessionLoaded;
    assert.equal(after.provider_session, native);
    assert.equal(after.transcript.entries.length, recovered.transcript.entries.length + 2);
    assert.equal(after.transcript.entries.at(-1).text, `${name}:${name}`);
    const records = await traces(trace);
    assert.equal(
      records.filter((entry) => entry.method === 'session/prompt' && entry.text === 'permission')
        .length,
      1,
    );
    assert(records.some((entry) => entry.method === 'session/load' && entry.sessionId === native));
    client.close();
    client = undefined;
    await stop(host);
    console.log(
      `ok   ${harness}: real SIGKILL, stale-socket refusal, explicit fixture cleanup, cold recovery, immutable replay/image and same-native continuation`,
    );
  }
  console.log(
    '3 real host process-loss checks passed (synthetic EOF-exiting peers; no live model/Bot, no automatic stale-socket recovery, not soak)',
  );
} finally {
  client?.close();
  for (const child of [...children]) {
    child.kill('SIGKILL');
    await child.done.catch(() => {});
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
  await rm(root, { recursive: true, force: true });
}
