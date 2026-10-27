// Versioned, storage-only baseline. No provider credentials, host root or Bot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pruneTestReports, reportRetention } from './lib/test-reports.mjs';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    workload: { type: 'string', default: 'storage' },
    release: { type: 'boolean', default: false },
  },
});
assert(['storage', 'diff'].includes(options.workload));
const testCase =
  options.workload === 'diff' ? 'large_diff_reader_workload_v1' : 'mixed_storage_workload_v1';

const directory = resolve('.test-results', `mixed-v1-${randomUUID()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const activeMarker = join(directory, '.active');
writeFileSync(activeMarker, String(process.pid), { mode: 0o600 });
process.once('exit', () => rmSync(activeMarker, { force: true }));
await pruneTestReports(resolve('.test-results'), reportRetention());
const built = spawnSync(
  'cargo',
  [
    'test',
    '--offline',
    '--locked',
    '--manifest-path',
    'rust/Cargo.toml',
    '-p',
    'pi-acp-workbenchd',
    '--lib',
    ...(options.release ? ['--release'] : []),
    '--no-run',
    '--message-format=json',
  ],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
assert.equal(built.status, 0, built.stderr);
const artifact = built.stdout
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse)
  .find(
    (item) =>
      item.reason === 'compiler-artifact' && item.executable && item.target.kind.includes('lib'),
  );
assert(artifact?.executable);
const executable = join(directory, 'mixed-tests');
copyFileSync(artifact.executable, executable);
chmodSync(executable, 0o700);
const summarize = (values) => {
  assert(values.length > 0 && values.every((n) => Number.isFinite(n) && n >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
};
const report = {
  version: 1,
  scope:
    'Storage-only diagnostic baseline, enqueue through commit. Not admission-to-fence SLO, provider/Bot/Extension Host acceptance, delivery lane simulation, or a long-running RSS trend.',
  machine: {
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    total_memory_bytes: totalmem(),
    kernel: release(),
    node: process.version,
  },
  binary_sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  build_configuration: options.release ? 'release' : 'debug',
  test_case: testCase,
  budgets: {
    admission_control_p95_ms: 100,
    admission_control_p99_ms: 250,
    page_p95_ms: 200,
    page_idle_regression_ratio: 1.2,
    enforced: false,
    reason:
      'S0 storage baseline; full host admission and reader A/B evidence remain separate gates.',
  },
  runs: [],
  pooled_request_ms: {},
};
const pooled = {};
for (let run = 0; run < 5; run++) {
  const metric = join(directory, `${run}.metrics`);
  const result = spawnSync(
    '/usr/bin/time',
    [
      '-f',
      '%e %M',
      '-o',
      metric,
      executable,
      `persistence::mixed_workload_tests::${testCase}`,
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(join(directory, `${run}.log`), result.stdout + result.stderr, { mode: 0o600 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed;/);
  const line = result.stdout.split('\n').find((line) => line.startsWith('MIXED_WORKLOAD_V1:'));
  assert(line, 'missing versioned workload result');
  const sample = JSON.parse(line.slice('MIXED_WORKLOAD_V1:'.length));
  assert.equal(sample.version, 1);
  const distributions = {};
  for (const [kind, values] of Object.entries(sample.latencies_ms)) {
    distributions[kind] = summarize(values);
    (pooled[kind] ??= []).push(...values);
  }
  const [elapsed_seconds, peak_rss_kib] = readFileSync(metric, 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number);
  report.runs.push({
    run,
    elapsed_seconds,
    peak_rss_kib,
    wal_bytes: sample.wal_bytes,
    workload: sample.workload,
    request_samples_ms: sample.latencies_ms,
    request_ms: distributions,
    storage: sample.storage,
  });
  console.log(JSON.stringify({ run, request_ms: distributions, peak_rss_kib }));
}
for (const [kind, values] of Object.entries(pooled))
  report.pooled_request_ms[kind] = summarize(values);
report.passed = true;
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(`PASS mixed storage baseline (not full release SLO): ${directory}`);
