// P1 worker-slot pressure regression against the actual host and stdio peers.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { WorkbenchWire, turnFinished, inlineText } from '../test/helpers/workbench-wire.mjs';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);
const root = await mkdtemp(join(tmpdir(), 'workbench-idle-turnover-'));
const trace = join(root, 'trace.ndjson');
let child, wire, done;
try {
  await mkdir(join(root, 'home'));
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      workers: {
        pi: {
          command: process.execPath,
          args: [resolve('test/contract-agent.mjs')],
          env: {
            WORKBENCH_CONTRACT_TRACE: trace,
            WORKBENCH_CONTRACT_NATIVE_STATE: join(root, 'native'),
          },
        },
      },
      sessions: { mailbox: 128, max_workers: 1 },
      telegram: null,
      storage: { root: join(root, 'data') },
      limits: { pending_interactions: 32 },
    }),
  );
  child = spawn(binary, ['--config', config], {
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (bytes) => {
    log += bytes;
  });
  child.stderr.on('data', (bytes) => {
    log += bytes;
  });
  done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 10000;
  while (!log.includes('ready:')) {
    assert(Date.now() < deadline && child.exitCode === null, log);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  wire = await WorkbenchWire.open(join(root, 'data', 'workbench.sock'));
  const samples = [];
  async function call(command, operation) {
    const start = performance.now();
    const result = await wire.call(command, operation);
    samples.push({ method: command.method, ms: performance.now() - start });
    return result;
  }
  const ids = [];
  for (let i = 0; i < 2; i++) {
    ids.push((await call({ method: 'create', harness: 'Pi', cwd: root })).Created.summary.id);
    await call({ method: 'attach', session: ids[i] });
  }
  let aNative;
  for (const [index, session] of [ids[0], ids[1], ids[0]].entries()) {
    const text = `worker-slot-${index}`;
    const finished = wire.waitFor((batch) => turnFinished(batch, session));
    const operation = `worker-slot-operation-${index}`;
    const receipt = await call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: text }] } },
      operation,
    );
    assert(receipt.Accepted, `input ${index} must be accepted exactly once`);
    await finished;
    const state = await call({ method: 'inspect', session });
    if (index === 0) aNative = state.provider_session;
    if (index === 2)
      assert.equal(state.provider_session, aNative, 'A resumes same provider session');
    const entries = (await call({ method: 'history', session })).entries;
    assert.equal(inlineText(entries.at(-1)), `echo: ${text}`);
    assert.equal((await call({ method: 'operation', operation })).status, 'completed');
  }
  assert.equal(
    (await call({ method: 'list' })).sessions.length,
    2,
    'turnover must not remove sessions',
  );
  const provider = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(
    provider.filter((row) => row.method === 'session/prompt').length,
    3,
    'no prompt replay',
  );
  assert.equal(
    provider.filter((row) => row.method === 'boot').length,
    3,
    'one worker per dispatched prompt',
  );
  assert(provider.some((row) => row.method === 'session/load' && row.sessionId === aNative));
  const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      version: 1,
      scope: 'actual host one-worker A→B→A native turnover',
      samples,
      p95_ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      p99_ms: ordered[Math.ceil(ordered.length * 0.99) - 1],
    }),
  );
  console.log('PASS one-slot A completes → B completes → A native session continues');
  wire.close();
  wire = undefined;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    assert.deepEqual(await done, { code: 0, signal: null });
  } finally {
    clearTimeout(timer);
  }
} finally {
  wire?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await done;
  }
  await rm(root, { recursive: true, force: true });
}
