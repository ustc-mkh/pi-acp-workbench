// Five independent process samples; timings/RSS are diagnostic, spies are gates.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = resolve('.test-results', `scale-${randomUUID()}`);
mkdirSync(directory, { recursive: true });
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
const cases = [
  'sqlite_100k_indexed_pagination_no_duplicates_or_missing_rows',
  'scale_10k_summaries_keyset_pages_do_not_read_history_or_hot_state',
  'incremental_hot_commands_do_not_decode_100k_history_or_read_old_tool_bodies',
  'telegram_100k_completed_inbox_is_not_read_by_offset_pending_admit_or_complete',
  'dispatch_delivery_scale_has_no_per_candidate_scan_and_matches_fifo_oracle',
  'mixed_three_restart_cycles_sixteen_workers_hundred_queries_thirty_two_interactions_and_storage_faults',
  'export_preserves_uncheckpointed_wal_and_restores_committed_rows',
];
const report = {
  samples: 5,
  scope:
    'bundled SQLite, synthetic ACP; per-process elapsed and peak RSS include fixture setup, not a production SLO; structural assertions are mandatory',
  cases: [],
};
for (const name of cases) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const metric = join(directory, `${name}-${i}.metrics`);
    const result = spawnSync(
      '/usr/bin/time',
      ['-f', '%e %M', '-o', metric, artifact.executable, name, '--nocapture', '--test-threads=1'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    writeFileSync(join(directory, `${name}-${i}.log`), result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed;/);
    const [seconds, rss_kib] = readFileSync(metric, 'utf8').trim().split(/\s+/).map(Number);
    samples.push({ elapsed_ms: seconds * 1000, rss_kib });
  }
  const percentile = (key, p) =>
    samples.map((sample) => sample[key]).sort((a, b) => a - b)[Math.ceil(p * samples.length) - 1];
  const summary = {
    name,
    samples,
    median_ms: percentile('elapsed_ms', 0.5),
    p95_ms: percentile('elapsed_ms', 0.95),
    median_rss_kib: percentile('rss_kib', 0.5),
    p95_rss_kib: percentile('rss_kib', 0.95),
  };
  report.cases.push(summary);
  console.log(JSON.stringify(summary));
}
report.passed = true;
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS scale: ${directory}`);
