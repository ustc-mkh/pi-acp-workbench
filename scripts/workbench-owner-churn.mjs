// P1 worker-slot pressure regression against the actual host and stdio peers.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { WorkbenchWire, turnFinished, inlineText } from '../test/helpers/workbench-wire.mjs';
import { sampleProcessTree } from './lib/workbench-process-tree.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    warm: { type: 'boolean', default: false },
    report: { type: 'string' },
    visits: { type: 'string', default: '200' },
    'max-owners': { type: 'string', default: '64' },
  },
});
const visits = Number(values.visits);
const maxOwners = Number(values['max-owners']);
assert(Number.isInteger(maxOwners) && maxOwners > 0 && maxOwners < visits);
assert(Number.isInteger(visits) && visits >= 20 && visits <= 10000);
const report = {
  version: 1,
  scope:
    'Isolated cold or synthetic warm create/load/worker eviction; whole live process tree plus bounded owner/task/queue metrics. No real model requests.',
  visits,
  acceptance_owner_budget: maxOwners,
  warm: values.warm,
  samples: [],
};
let failure;
const binary = resolveWorkbenchBinary(values.binary);
const root = await mkdtemp(join(tmpdir(), 'workbench-owner-churn-'));
const trace = join(root, 'trace.ndjson');
let child, wire, done;
let log = '';
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
    env: {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      LANG: 'C.UTF-8',
      WORKBENCH_DIAGNOSTICS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (bytes) => {
    log += bytes;
  });
  child.stderr.on('data', (bytes) => {
    log += bytes;
  });
  done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 10000;
  while (!log.includes('ready:')) {
    assert(Date.now() < deadline && child.exitCode === null, log);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  wire = await WorkbenchWire.open(join(root, 'data', 'workbench.sock'));
  const samples = [];
  report.requests = samples;
  async function call(command, operation) {
    const start = performance.now();
    const result = await wire.call(command, operation);
    samples.push({ method: command.method, ms: performance.now() - start });
    return result;
  }
  let first;
  async function turn(session, text, operation) {
    const finished = wire.waitFor((batch) => turnFinished(batch, session));
    const command = { method: 'prompt', session, prompt: { parts: [{ type: 'text', text }] } };
    const receipt = await call(command, operation);
    assert(receipt.Accepted);
    await finished;
    const state = await call({ method: 'inspect', session });
    const history = await call({ method: 'history', session });
    assert.equal(inlineText(history.entries.at(-1)), `echo: ${text}`);
    return { native: state.provider_session, receipt, command, operation };
  }
  for (let index = 0; index < visits; index++) {
    const id = (await call({ method: 'create', harness: 'Pi', cwd: root }, randomUUID())).Created
      .summary.id;
    await call({ method: 'load', session: id });
    if (values.warm) {
      await call({ method: 'attach', session: id });
      const result = await turn(id, `owner-warm-${index}`, randomUUID());
      if (index === 0) first = { session: id, ...result };
      await call({ method: 'detach', session: id });
    }
    if (index % 20 === 19)
      report.samples.push({ visited: index + 1, tree: await sampleProcessTree(child.pid) });
  }
  if (values.warm) {
    await call({ method: 'attach', session: first.session });
    const restored = await turn(first.session, 'owner-warm-resumed', randomUUID());
    assert.equal(
      restored.native,
      first.native,
      'cache eviction preserves same native provider session',
    );
    assert.deepEqual(
      await call(first.command, first.operation),
      first.receipt,
      'original receipt replays without redispatch',
    );
    const rows = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const prompts = rows.filter((row) => row.method === 'session/prompt');
    assert.equal(prompts.length, visits + 1, 'no prompt replay on owner/worker cold load');
    report.provider = {
      prompts: prompts.length,
      trace_sha256: createHash('sha256')
        .update(await readFile(trace))
        .digest('hex'),
      same_native_resume: true,
      receipt_replay: true,
    };
  }
  report.binary_sha256 = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  report.runner_sha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex');
  report.requests = samples;
  wire.close();
  wire = undefined;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    assert.deepEqual(await done, { code: 0, signal: null });
  } finally {
    clearTimeout(timer);
  }
  const records = log
    .split('\n')
    .filter((line) => line.startsWith('workbench-metrics: '))
    .map((line) => JSON.parse(line.slice('workbench-metrics: '.length)));
  assert.equal(records.length, 1, 'exactly one normal shutdown metrics record');
  report.metrics = records[0];
  report.joined = true;
  report.host_log_sha256 = createHash('sha256').update(log).digest('hex');
  const owners = report.metrics.runtime.gauges.owners;
  report.plateau_observed = owners.peak <= maxOwners;
  // A shutdown zero alone is not evidence of a steady-state plateau.
  assert.equal(owners.current, 0, 'all owners joined at shutdown');
  assert(
    report.metrics.runtime.gauges.owner_tasks.peak <= maxOwners + 17,
    'retiring tasks remain bounded and joined',
  );
  assert.equal(report.metrics.runtime.gauges.owner_tasks.current, 0);
  assert(
    report.samples.every((sample) => sample.tree.count <= (values.warm ? 2 : 1)),
    'live worker process count bounded by configured one-worker limit',
  );
  assert(
    report.plateau_observed,
    `owners retained across ${visits} cold loads: peak=${owners.peak}`,
  );
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = String(error.stack || error);
} finally {
  wire?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await done;
  }
  if (values.report) {
    await writeFile(values.report + '.host.log', log);
    const providerTrace = await readFile(trace).catch(() => null);
    if (providerTrace) await writeFile(values.report + '.provider.ndjson', providerTrace);
  }
  if (report.passed) await rm(root, { recursive: true, force: true });
  else {
    report.retained_root = root;
    await writeFile(join(root, 'host.log'), log);
  }
}

if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: report.passed,
    plateau: report.plateau_observed,
    report: values.report,
  }),
);
if (failure) throw failure;
