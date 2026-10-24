// Real frozen host + isolated synthetic ACP peers. No provider credentials/network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { WorkbenchWire, inlineText } from '../test/helpers/workbench-wire.mjs';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);
const evidence = resolve('.test-results', `provider-barriers-v1-${randomUUID()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const digest = async (p) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const report = {
  version: 1,
  binary_sha256: await digest(binary),
  fixture_sha256: await digest('test/contract-agent.mjs'),
  runner_sha256: await digest(import.meta.filename),
  scope:
    'Actual host/worker processes; synthetic request barriers, cancellation/removal, idle reclamation and subsequent input. Not online provider acceptance or all P6 cuts.',
  passed: false,
  cases: [],
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 4000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error(`barrier timeout: ${label}`);
}
async function exists(path) {
  return !!(await readFile(path).catch(() => null));
}
async function alive(pid) {
  const s = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
  return !!s && !s.slice(s.lastIndexOf(')') + 2).startsWith('Z ');
}
async function runCase(kind, stopMethod) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-provider-barrier-'));
  const gate = join(root, 'request'),
    trace = join(root, 'trace.ndjson');
  const record = { kind, stop: stopMethod, checks: [], timings_ms: {}, hosts: [], passed: false };
  report.cases.push(record);
  let host, client;
  const data = join(root, 'data');
  async function start() {
    host = spawn(binary, ['--config', join(root, 'config.json')], {
      env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.output = '';
    for (const stream of [host.stdout, host.stderr]) stream.on('data', (b) => (host.output += b));
    host.done = new Promise((res, rej) => {
      host.once('error', rej);
      host.once('exit', (code, signal) => {
        record.hosts.push({ pid: host.pid, code, signal, output: host.output });
        res({ code, signal });
      });
    });
    await until(() => {
      if (host.exitCode !== null) throw new Error(host.output);
      return host.output.includes('ready:');
    }, 'host startup');
    client = await WorkbenchWire.open(join(data, 'workbench.sock'));
  }
  async function stopHost() {
    client?.close();
    if (!host || host.exitCode !== null) return;
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 8000);
    try {
      assert.deepEqual(await host.done, { code: 0, signal: null }, host.output);
    } finally {
      clearTimeout(timer);
    }
  }
  const call = (cmd, op) => client.call(cmd, op);
  async function timed(label, action) {
    const t = performance.now();
    const v = await action();
    record.timings_ms[label] = performance.now() - t;
    return v;
  }
  async function create() {
    return (await call({ method: 'create', harness: 'Pi', cwd: root })).Created.summary.id;
  }
  async function prompt(session, text) {
    const receipt = await call({
      method: 'prompt',
      session,
      prompt: { parts: [{ type: 'text', text }] },
    });
    await until(async () => {
      const v = await call({ method: 'inspect', session });
      const h = await call({ method: 'history', session, limit: 100 });
      return (
        !v.active_turn &&
        h.entries.some((e) => e.role === 'Agent' && inlineText(e) === `echo: ${text}`)
      );
    }, `prompt ${text}`);
    return receipt;
  }
  try {
    const method = {
      discovery: 'initialize',
      configuration: 'session/set_config_option',
      title: '_pi_workbench/title',
      fork: '_pi_workbench/fork',
    }[kind];
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        workers: {
          pi: {
            command: process.execPath,
            args: [resolve('test/contract-agent.mjs')],
            env: {
              WORKBENCH_CONTRACT_REQUEST_GATE: gate,
              WORKBENCH_CONTRACT_REQUEST_METHOD: method,
              WORKBENCH_CONTRACT_NATIVE_STATE: join(root, 'native'),
              WORKBENCH_CONTRACT_MANAGEMENT: kind === 'title' ? '1' : '',
              WORKBENCH_CONTRACT_TRACE: trace,
            },
          },
        },
        storage: { root: data },
        sessions: { mailbox: 128, max_workers: 2 },
        telegram: null,
        limits: { pending_interactions: 32 },
      }),
    );
    await start();
    const session = await create(),
      other = await create(),
      third = await create();
    // Cold discovery claims initialize first; the remaining cases need an idle native source.
    if (kind !== 'discovery') await prompt(session, 'source prefix');
    const command =
      kind === 'discovery'
        ? { method: 'discover', session }
        : kind === 'configuration'
          ? { method: 'set_model', session, model: 'other' }
          : {
              method: 'fork',
              session,
              request: {
                entry: (await call({ method: 'history', session, limit: 100 })).entries[0].id,
              },
            };
    const operation = `barrier-${kind}-${stopMethod}`;
    let settled = false;
    const pending = (
      kind === 'title' ? Promise.resolve({ title_job: true }) : call(command, operation)
    )
      .then(
        (receipt) => ({ receipt }),
        (e) => ({ error: { code: e.code, message: e.message } }),
      )
      .then((outcome) => {
        record.outcome = outcome;
        if (kind !== 'title') settled = true;
        return outcome;
      });
    await until(() => exists(`${gate}.started`), 'provider RPC held');
    const held = JSON.parse(await readFile(`${gate}.started`, 'utf8'));
    record.barrier = held;
    assert(!settled);
    assert(await alive(held.pid));
    await timed('query_while_held', () => call({ method: 'inspect', session }));
    if (kind === 'title') {
      await timed('same_session_prompt_while_title_held', () =>
        prompt(session, 'same while title held'),
      );
      await call({ method: 'manage', session, action: { action: 'rename', title: 'Manual wins' } });
      record.checks.push('title RPC does not block same-session input or manual rename');
    }
    await timed('other_prompt_while_held', () => prompt(other, 'other while held'));
    assert(!settled);
    assert(await alive(held.pid));
    record.checks.push('queries and independent prompt finish before barrier release');
    // With max_workers=2, this third input must reclaim an idle worker, not
    // the worker pinned by discovery/configuration/fork.
    await timed('reclaim_and_third_prompt', () => prompt(third, 'third while held'));
    assert(!settled);
    assert(await alive(held.pid));
    const boots = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((x) => x.method === 'boot');
    const live = [];
    for (const b of boots) if (await alive(b.pid)) live.push(b.pid);
    assert.equal(live.length, 2);
    assert(live.includes(held.pid));
    record.live_workers_before_stop = live;
    record.checks.push(
      'idle worker reclaimed at capacity; held worker retained; exactly two live workers',
    );
    const stop = { method: stopMethod, session };
    record.stop_receipt = await timed('stop_including_join', () => call(stop, `${operation}-stop`));
    record.outcome = await pending;
    if (kind !== 'title') {
      assert(record.outcome.error, JSON.stringify(record.outcome));
      assert.match(record.outcome.error.code, /operation_interrupted|native_fork_uncertain/);
    }
    await until(async () => !(await alive(held.pid)), 'held worker physically joined');
    assert(!(await exists(`${gate}.release`)));
    record.checks.push(
      'stop/removal interrupts unanswered RPC and physically joins without barrier release',
    );
    if (stopMethod === 'remove')
      await assert.rejects(
        call({ method: 'inspect', session }),
        (e) =>
          e.code === 'operation_failed' &&
          e.message === 'operation_failed: ACP protocol: query target not found',
      );
    else await timed('same_session_new_input', () => prompt(session, 'after stop'));
    const beforeRestart = await call({ method: 'history', session: third, limit: 100 });
    await stopHost();
    await start();
    const replay = await call(stop, `${operation}-stop`);
    assert.deepEqual(replay, record.stop_receipt);
    assert.deepEqual(await call({ method: 'history', session: third, limit: 100 }), beforeRestart);
    record.checks.push('restart replays original stop receipt; independent history unchanged');
    record.passed = true;
  } finally {
    await stopHost();
    await writeFile(
      join(evidence, `${kind}-${stopMethod}-trace.ndjson`),
      await readFile(trace).catch(() => ''),
    );
    record.passed && (await rm(root, { recursive: true, force: true }));
    if (!record.passed) record.retained_root = root;
  }
}
try {
  for (const kind of ['discovery', 'configuration', 'fork', 'title'])
    for (const stop of ['cancel', 'remove']) await runCase(kind, stop);
  assert.equal(await digest(binary), report.binary_sha256);
  assert.equal(await digest('test/contract-agent.mjs'), report.fixture_sha256);
  assert.equal(await digest(import.meta.filename), report.runner_sha256);
  report.passed = true;
  console.log(`PASS provider barrier matrix: ${evidence} (${report.cases.length} cases)`);
} catch (e) {
  report.error = e.stack;
  throw e;
} finally {
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
