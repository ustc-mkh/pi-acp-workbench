// Real host IPC diagnostics. Isolated synthetic peers only; never real credentials.
// Request distributions are pooled across five runs, not percentiles of run means.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  copyFile,
  rename,
  chmod,
  readdir,
  stat,
} from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { WorkbenchWire, turnFinished } from '../test/helpers/workbench-wire.mjs';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { seedMixedFixture } from './lib/workbench-mixed-fixture.mjs';
import { sampleProcessTree } from './lib/workbench-process-tree.mjs';
import { startMixedUI } from './lib/workbench-mixed-ui.mjs';
const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    diagnostics: { type: 'boolean', default: false },
    runs: { type: 'string', default: '5' },
    'duration-seconds': { type: 'string', default: '30' },
    'backlog-seconds': { type: 'string' },
    dataset: { type: 'string', default: 'small' },
    'p0-baseline': { type: 'boolean', default: false },
  },
});
const runs = Number(values.runs),
  duration = Number(values['duration-seconds']);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 20);
assert(Number.isInteger(duration) && duration >= 5 && duration <= 86400);
assert(['small', 'full'].includes(values.dataset));
const full = values.dataset === 'full';
const backlogDuration = Number(values['backlog-seconds'] ?? duration);
assert(
  Number.isInteger(backlogDuration) && backlogDuration >= duration && backlogDuration <= 86400,
);
assert(
  !values['p0-baseline'] || values.binary,
  'historical P0 requires its explicit frozen binary',
);
const promptBody = (text) => (values['p0-baseline'] ? text : { parts: [{ type: 'text', text }] });
const directory = resolve('.test-results', `host-mixed-v1-${randomUUID()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const binary = join(directory, 'pi-acp-workbenchd');
const sourceBinary = resolveWorkbenchBinary(values.binary);
await copyFile(sourceBinary, binary);
await chmod(binary, 0o700);
const fixture = join(directory, 'fixture');
await mkdir(join(fixture, 'helpers'), { recursive: true });
for (const file of ['contract-agent.mjs', 'helpers/native-fork-fixture.mjs'])
  await copyFile(join('test', file), join(fixture, file));
await copyFile('scripts/workbench-host-mixed.mjs', join(directory, 'runner.mjs'));
await copyFile('scripts/lib/workbench-mixed-fixture.mjs', join(directory, 'mixed-fixture.mjs'));
const uiHashes = {};
for (const file of [
  'scripts/lib/workbench-mixed-ui.mjs',
  'scripts/lib/workbench-render-workload.mjs',
  'dist/webview.js',
  'dist/style.css',
]) {
  const name = file.split('/').at(-1);
  await copyFile(file, join(directory, name));
  uiHashes[file] = createHash('sha256')
    .update(await readFile(join(directory, name)))
    .digest('hex');
}
const pooled = {};
function distribution(values) {
  assert(values.length && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return {
    count: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
}
const report = {
  version: 1,
  scope:
    'Actual IPC host, 16 synthetic active sessions, independent idle settings, concurrent list/history and archived content reads. End-to-end IPC timings include workspace capture and physical cancel join; not internal admission/owner/SQL stage timings.',
  dataset: values.dataset,
  prompt_encoding: values['p0-baseline']
    ? 'historical P0 string (test-only)'
    : 'current typed parts',
  uncovered: [
    ...(!full
      ? [
          '10k sessions + 100k history in this same host workload',
          '4 MiB media',
          '8 HTTP delivery lanes + 2048 deferred topics',
        ]
      : []),
    ...(!full ? ['UI frame timing in this mixed host workload'] : []),
    ...(values.diagnostics ? [] : ['internal admission/owner/SQL attribution']),
    'P0 same-machine A/B baseline',
  ],
  machine: {
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    total_memory_bytes: totalmem(),
    kernel: release(),
    node: process.version,
  },
  binary_source: sourceBinary,
  build_configuration: values.binary
    ? 'explicit artifact; see its manifest'
    : 'default debug build',
  binary_sha256: createHash('sha256')
    .update(await readFile(binary))
    .digest('hex'),
  runner_sha256: createHash('sha256')
    .update(await readFile(join(directory, 'runner.mjs')))
    .digest('hex'),
  dataset_fixture_sha256: createHash('sha256')
    .update(await readFile(join(directory, 'mixed-fixture.mjs')))
    .digest('hex'),
  ui_source_sha256: uiHashes,
  fixture_sha256: Object.fromEntries(
    await Promise.all(
      ['contract-agent.mjs', 'helpers/native-fork-fixture.mjs'].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(fixture, file)))
          .digest('hex'),
      ]),
    ),
  ),
  duration_seconds_per_host: duration,
  delivery_backlog_seconds: full ? backlogDuration : null,
  started_at: new Date().toISOString(),
  runs: [],
  pooled_request_ms: {},
  passed: false,
};
let interrupted = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    interrupted = true;
  });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failure;
try {
  for (let run = 0; run < runs && !interrupted; run++) {
    const root = await mkdtemp(join(tmpdir(), 'workbench-host-mixed-'));
    let child,
      wire,
      done,
      log = '',
      timer;
    let server, dataset, mediaWire;
    let ui,
      uiTask,
      uiError,
      stopUI = false;
    const uiSamples = [];
    const checkpointOutcomes = [],
      checkpointErrors = [];
    const http = { active: 0, peak: 0, counts: Array(8).fill(0), error: null };
    let httpWarm = false,
      releaseHTTPWarm;
    const allLanesEntered = new Promise((resolve) => {
      releaseHTTPWarm = resolve;
    });
    const samples = {},
      resources = [];
    let diagnosticRecords = [];
    let rounds = 0;
    try {
      await mkdir(join(root, 'workspace'));
      await mkdir(join(root, 'home'));
      const config = join(root, 'config.json'),
        data = join(root, 'data');
      const configuration = {
        storage: { root: data },
        workers: {
          pi: { command: process.execPath, args: [join(fixture, 'contract-agent.mjs')], env: {} },
        },
        sessions: { mailbox: 128, max_workers: 16 },
        limits: { pending_interactions: 32 },
        telegram: null,
      };
      await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
      const launch = () => {
        diagnosticRecords = [];
        child = spawn(binary, ['--config', config], {
          detached: true,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            LANG: 'C.UTF-8',
            ...(values.diagnostics ? { WORKBENCH_DIAGNOSTICS: '1' } : {}),
            ...(full ? { WORKBENCH_MIXED_BOT: '999:ISOLATED_SYNTHETIC_FIXTURE' } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        done = new Promise((res, rej) => {
          child.once('error', rej);
          child.once('close', (code, signal) => res({ code, signal }));
        });
        for (const stream of [child.stdout, child.stderr]) {
          let pendingLine = '';
          stream.on('data', (c) => {
            log = (log + c).slice(-65536);
            const lines = (pendingLine + c).split('\n');
            pendingLine = lines.pop().slice(-65536);
            for (const line of lines) {
              if (line.startsWith('workbench-metrics: '))
                diagnosticRecords.push(JSON.parse(line.slice('workbench-metrics: '.length)));
              const match =
                /^WAL reuse checkpoint: busy=(true|false) log_frames=(\d+) checkpointed_frames=(\d+) elapsed_us=(\d+) busy_wait_budget_ms=20$/.exec(
                  line,
                );
              if (match)
                checkpointOutcomes.push({
                  busy: match[1] === 'true',
                  log_frames: Number(match[2]),
                  checkpointed_frames: Number(match[3]),
                  elapsed_us: Number(match[4]),
                  busy_wait_budget_ms: 20,
                });
              if (line.startsWith('WAL reuse checkpoint failed:')) checkpointErrors.push(line);
            }
          });
        }
      };
      launch();
      const ready = async () => {
        const deadline = Date.now() + 15000;
        while (!wire) {
          assert(Date.now() < deadline && child.exitCode === null, `startup: ${log}`);
          try {
            wire = await WorkbenchWire.open(join(data, 'workbench.sock'));
          } catch {
            await delay(20);
          }
        }
      };
      await ready();
      const call = (command, mutation = false) =>
        wire.call(command, mutation ? randomUUID() : undefined);
      const sessions = [];
      for (let n = 0; n < 17; n++)
        sessions.push(
          (await call({ method: 'create', harness: 'Pi', cwd: join(root, 'workspace') }, true))
            .Created.summary.id,
        );
      const idle = sessions.pop(),
        archive = sessions[0];
      await call({ method: 'attach', session: archive });
      const finished = wire.waitFor((batch) => turnFinished(batch, archive));
      await call({ method: 'prompt', session: archive, prompt: promptBody('big') }, true);
      await finished;
      const page = await call({ method: 'history', session: archive, limit: 100 });
      const reference = page.entries.find((e) => e.text.Archived)?.text.Archived;
      assert(reference, '600 KiB archived body fixture missing');
      let ref = reference.content || reference;
      if (full) {
        wire.close();
        wire = undefined;
        process.kill(-child.pid, 'SIGTERM');
        timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 15000);
        assert.deepEqual(await done, { code: 0, signal: null }, log);
        clearTimeout(timer);
        dataset = seedMixedFixture(data, archive, backlogDuration);
        ref = dataset.content;
        server = createServer(async (request, response) => {
          try {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            const method = request.url.split('/').at(-1);
            let result;
            if (method === 'getMe') result = { id: 999, is_bot: true, username: 'mixed_fixture' };
            else if (method === 'getUpdates') {
              await delay(100);
              result = [];
            } else if (method === 'sendMessage') {
              const lane = body.message_thread_id - 10000;
              assert(
                Number.isInteger(lane) && lane >= 0 && lane < 8,
                'deferred topic must never send',
              );
              const match = /ready:(\d+):(\d+)/.exec(body.text);
              assert(
                match && Number(match[1]) === lane && Number(match[2]) === http.counts[lane],
                'per-topic FIFO',
              );
              http.active++;
              http.peak = Math.max(http.peak, http.active);
              // Hold the first wave until all eight lanes are physically in
              // HTTP. Sampling a short sleep is not a reliable concurrency test.
              if (!httpWarm) {
                if (http.active === 8) {
                  httpWarm = true;
                  releaseHTTPWarm();
                }
                await allLanesEntered;
              }
              await delay(50);
              http.active--;
              http.counts[lane]++;
              result = {
                message_id: http.counts[lane],
                chat: { id: -100 },
                message_thread_id: body.message_thread_id,
                text: body.text,
              };
            } else throw new Error(`unexpected synthetic HTTP method: ${method}`);
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ ok: true, result }));
          } catch (error) {
            http.error = String(error.stack || error);
            response.statusCode = 500;
            response.end('{}');
          }
        });
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        configuration.telegram = {
          bot_token_env: 'WORKBENCH_MIXED_BOT',
          workspace: join(root, 'workspace'),
          allowed_chat_ids: [-100],
          allowed_user_ids: [5],
          api_base: `http://127.0.0.1:${server.address().port}/`,
          inbox_capacity: 128,
        };
        await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
        launch();
        await ready();
        mediaWire = await WorkbenchWire.open(join(data, 'workbench.sock'));
        const laneDeadline = performance.now() + 15000;
        while (!httpWarm) {
          assert.equal(http.error, null);
          assert(
            performance.now() < laneDeadline,
            'all eight HTTP lanes must enter the warmup barrier',
          );
          await delay(10);
        }
      }
      await Promise.all(
        sessions.map((session) =>
          call({ method: 'prompt', session, prompt: promptBody('wait') }, true),
        ),
      );
      // Warm-up is explicitly excluded from request samples.
      await Promise.all([
        call({ method: 'list', limit: 100 }),
        call({ method: 'history', session: archive, limit: 100 }),
      ]);
      async function timed(kind, command, mutation = false) {
        const start = performance.now();
        // Respect the per-connection four-query budget. Independent media /
        // export readers represent another client, not a raised host reserve.
        const result =
          mediaWire && ['image_4m', 'export_slice'].includes(kind)
            ? await mediaWire.call(command)
            : await call(command, mutation);
        (samples[kind] ??= []).push(performance.now() - start);
        return result;
      }
      async function resource() {
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
        resources.push({
          elapsed_ms: performance.now() - began,
          process_tree: await sampleProcessTree(child.pid),
          rss_kib: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
          threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1]),
          fds: (await readdir(`/proc/${child.pid}/fd`)).length,
          wal_bytes: await stat(join(data, 'workbench.sqlite3-wal'))
            .then((s) => s.size)
            .catch(() => 0),
        });
      }
      if (full) {
        ui = await startMixedUI(join(data, 'workbench.sock'), join(root, 'workspace'), idle);
      }
      const began = performance.now();
      if (full) {
        uiTask = (async () => {
          while (!stopUI) {
            uiSamples.push({ elapsed_ms: performance.now() - began, metrics: await ui.sample() });
          }
        })();
        uiTask.catch((error) => {
          uiError = error;
        });
      }
      let nextProgress = began;
      while (!interrupted && performance.now() - began < duration * 1000) {
        const active = sessions[rounds % sessions.length];
        await Promise.all([
          timed('list', { method: 'list', limit: 100 }),
          timed('history', { method: 'history', session: archive, limit: 100 }),
          timed('content', { method: 'content', ref: ref, offset: 0 }),
          ...(full
            ? [
                timed('image_4m', { method: 'image', image: dataset.image }).then((asset) =>
                  assert.deepEqual(asset.image, dataset.image),
                ),
                (async () => {
                  let offset = 0,
                    bytes = 0;
                  do {
                    const page = await timed('export_slice', { method: 'content', ref, offset });
                    bytes += Buffer.byteLength(page.text);
                    offset = page.next_offset;
                  } while (offset !== null);
                  assert.equal(bytes, ref.bytes);
                })(),
              ]
            : []),
          timed(
            'idle_setting',
            { method: 'set_model', session: idle, model: rounds % 2 ? 'default' : 'other' },
            true,
          ),
          (async () => {
            await timed('cancel_including_join', { method: 'cancel', session: active }, true);
            await timed(
              'prompt_including_capture',
              {
                method: 'prompt',
                session: active,
                prompt: promptBody('wait'),
              },
              true,
            );
          })(),
        ]);
        assert.equal(http.error, null);
        if (uiError) throw uiError;
        if (rounds % 10 === 0) await resource();
        wire.requests.length = 0;
        if (mediaWire) mediaWire.requests.length = 0;
        rounds++;
        if (performance.now() >= nextProgress) {
          // Atomically retain a live, explicitly incomplete checkpoint. A killed
          // runner must not erase two hours of diagnostic evidence or look passed.
          const progress = {
            passed: false,
            state: 'running',
            run,
            pid: child.pid,
            rounds,
            duration_ms: performance.now() - began,
            request_samples_ms: samples,
            resources,
          };
          const path = join(directory, `${run}-progress.json`);
          await writeFile(`${path}.tmp`, JSON.stringify(progress), { mode: 0o600 });
          await rename(`${path}.tmp`, path);
          console.log(
            JSON.stringify({
              run,
              pid: child.pid,
              rounds,
              elapsed_seconds: progress.duration_ms / 1000,
              resource: resources.at(-1),
            }),
          );
          nextProgress = performance.now() + 60000;
        }
        await delay(20);
      }
      stopUI = true;
      await uiTask;
      await ui?.close();
      ui = undefined;
      await resource();
      const request_ms = {};
      for (const [kind, latencies] of Object.entries(samples)) {
        request_ms[kind] = distribution(latencies);
        // A two-hour run exceeds V8's function argument limit. Append without
        // spreading samples into arguments; retain every individual request.
        const combined = (pooled[kind] ??= []);
        for (const latency of latencies) combined.push(latency);
      }
      report.runs.push({
        run,
        pid: child.pid,
        rounds,
        duration_ms: performance.now() - began,
        request_ms,
        request_samples_ms: samples,
        resources,
        ...(full ? { dataset, http: { ...http, counts: [...http.counts] }, ui: uiSamples } : {}),
      });
      console.log(JSON.stringify({ run, rounds, request_ms, resources: resources.at(-1) }));
      wire.close();
      wire = undefined;
      mediaWire?.close();
      mediaWire = undefined;
      process.kill(-child.pid, 'SIGTERM');
      timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 15000);
      const shutdown = await done;
      report.runs.at(-1).shutdown = shutdown;
      report.runs.at(-1).wal_checkpoints = checkpointOutcomes;
      report.runs.at(-1).wal_checkpoint_errors = checkpointErrors;
      assert.deepEqual(shutdown, { code: 0, signal: null }, log);
      assert.equal(checkpointErrors.length, 0, checkpointErrors.join('\n'));
      if (values.diagnostics) {
        const metrics = diagnosticRecords;
        assert.equal(
          metrics.length,
          1,
          'normal joined shutdown emits one bounded internal metrics record',
        );
        report.runs.at(-1).internal_metrics = metrics[0];
        for (const label of [
          'admission_queue',
          'registry_queue',
          'owner_queue',
          'sqlite_commit_call',
        ])
          assert(metrics[0].runtime.timings[label]?.count > 0, label);
      }
      if (full) {
        assert(
          uiSamples.length > 0,
          '1000-fragment UI samples must run concurrently with host load',
        );
        assert.equal(http.error, null);
        assert.equal(http.peak, 8, 'all eight delivery lanes must be exercised');
        assert(
          http.counts.every((count) => count > 0 && count < dataset.per_lane),
          'all ready topics progress throughout the workload',
        );
      }
    } catch (error) {
      // Failed requests are never pooled into successful latency samples, but
      // preserve every partial sample and the live host's wait/resource state.
      // A timeout must remain diagnosable even before the next minute checkpoint.
      const diagnostic = async (path) =>
        readFile(path, 'utf8').catch((failure) => String(failure.code || failure));
      const threads = child?.pid ? await readdir(`/proc/${child.pid}/task`).catch(() => []) : [];
      report.incomplete_run = {
        run,
        pid: child?.pid,
        rounds,
        request_samples_ms: samples,
        resources,
        ui: uiSamples,
        wal_checkpoints: checkpointOutcomes,
        wal_checkpoint_errors: checkpointErrors,
        ...(full ? { dataset, http: { ...http, counts: [...http.counts] } } : {}),
        error: String(error.stack || error),
        host_status: child?.pid ? await diagnostic(`/proc/${child.pid}/status`) : null,
        thread_waits: Object.fromEntries(
          await Promise.all(
            threads.map(async (id) => [
              id,
              await diagnostic(`/proc/${child.pid}/task/${id}/wchan`),
            ]),
          ),
        ),
        loadavg: await diagnostic('/proc/loadavg'),
        memory: await diagnostic('/proc/meminfo'),
      };
      throw error;
    } finally {
      releaseHTTPWarm();
      stopUI = true;
      await uiTask?.catch(() => {});
      await ui?.close();
      if (wire)
        await writeFile(
          join(directory, `${run}-requests.json`),
          JSON.stringify(wire.requests.slice(-25), null, 2),
        );
      clearTimeout(timer);
      wire?.close();
      mediaWire?.close();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        await done.catch(() => {});
      }
      await writeFile(join(directory, `${run}.log`), log, { mode: 0o600 });
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(root, { recursive: true, force: true });
    }
  }
  assert(!interrupted, 'interrupted');
  for (const [kind, latencies] of Object.entries(pooled))
    report.pooled_request_ms[kind] = distribution(latencies);
  report.passed = report.runs.length === runs;
} catch (error) {
  failure = error;
  report.error = String(error.stack || error);
}
report.finished_at = new Date().toISOString();
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  `${report.passed ? 'PASS' : 'FAIL'} host mixed diagnostics (not full release SLO): ${directory}`,
);
if (failure) throw failure;
