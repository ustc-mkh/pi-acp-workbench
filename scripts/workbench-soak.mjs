// Bounded, reproducible sustained local fixture run. Not live traffic or an
// overnight production soak. Every round joins before the next round starts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, rmSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { pruneTestReports, reportRetention } from './lib/test-reports.mjs';
const { values } = parseArgs({
  options: {
    'duration-seconds': { type: 'string', default: '600' },
    binary: { type: 'string' },
  },
});
const duration = Number(values['duration-seconds']);
assert(
  Number.isInteger(duration) && duration >= 60 && duration <= 86400,
  'duration must be 60..86400 seconds',
);
const directory = resolve('.test-results', `soak-${randomUUID()}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const activeMarker = join(directory, '.active');
await writeFile(activeMarker, String(process.pid), { mode: 0o600 });
process.once('exit', () => rmSync(activeMarker, { force: true }));
await pruneTestReports(resolve('.test-results'), reportRetention());
// Freeze executable inputs once. Recompiling each round allowed concurrent
// development to silently change the code under a nominal 600-second sample.
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
const tests = join(directory, 'soak-tests'),
  binary = join(directory, 'pi-acp-workbenchd');
await copyFile(artifact.executable, tests);
await copyFile(resolveWorkbenchBinary(values.binary), binary);
await chmod(tests, 0o700);
await chmod(binary, 0o700);
let interrupted = false;
// Stop between joined phases, not by killing an accepted file transaction.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
  });
const began = Date.now();
const phases = [];
let rounds = 0;
async function phase(name, command, args, expected) {
  const file = join(directory, `${rounds}-${name}.log`);
  const fd = openSync(file, 'wx', 0o600);
  const started = Date.now();
  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', fd, fd], detached: true });
  } finally {
    closeSync(fd);
  }
  const result = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  phases.push({ round: rounds, name, elapsed_ms: Date.now() - started, ...result, file });
  assert(result.code === 0 && result.signal === null, `soak phase failed: ${file}`);
  assert(
    (await readFile(file, 'utf8')).includes(expected),
    `required tests were not executed: ${file}`,
  );
  return file;
}
const rust = (name, test) =>
  phase(name, tests, [test, '--exact'], 'test result: ok. 1 passed; 0 failed;');
let error;
try {
  while (!interrupted && (rounds < 2 || Date.now() - began < duration * 1000)) {
    await rust(
      'mixed',
      'app::tests::load_tests::mixed_three_restart_cycles_sixteen_workers_hundred_queries_thirty_two_interactions_and_storage_faults',
    );
    if (interrupted) break;
    await rust(
      'three-providers',
      'app::tests::provider_tests::all_three_synthetic_profiles_cover_plan_usage_permission_forms_cancel_crash_and_native_restart',
    );
    if (interrupted) break;
    await rust(
      'management',
      'app::tests::management_tests::management_prices_stats_missing_usage_filters_and_restart_are_cold_and_durable',
    );
    if (interrupted) break;
    await rust(
      'isolated-title',
      'app::tests::management_tests::isolated_title_does_not_block_next_prompt_or_overwrite_manual_name_and_counts_once',
    );
    if (interrupted) break;
    const lossLog = await phase(
      'process-loss',
      process.execPath,
      ['scripts/workbench-process-loss.mjs', '--binary', binary],
      '3 provider profiles / 11 process-loss windows passed:',
    );
    const evidence = (await readFile(lossLog, 'utf8')).match(
      /11 process-loss windows passed: (.+) \(synthetic peers;/,
    )?.[1];
    assert(evidence?.startsWith(resolve('.test-results', 'process-loss-v2-')));
    const loss = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'));
    assert.equal(loss.version, 2);
    assert.equal(loss.passed, true);
    assert.equal(loss.windows.length, 11);
    assert.equal(
      loss.binary_sha256,
      createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
    );
    assert(
      loss.windows.some(
        (window) => window.window === 'remote-fork-returned-source-join-before-adoption',
      ),
    );
    assert(
      loss.windows.some(
        (window) => window.window === 'HTTP-success-client-frozen-before-local-ack',
      ),
    );
    phases.at(-1).evidence = evidence;
    rounds++;
    console.log(
      `soak round ${rounds} joined; elapsed ${((Date.now() - began) / 1000).toFixed(1)}s; logs ${directory}`,
    );
  }
} catch (cause) {
  error = String(cause);
}
const report = {
  passed: !error && !interrupted && rounds >= 2 && Date.now() - began >= duration * 1000,
  executable_sha256: {
    tests: createHash('sha256')
      .update(await readFile(tests))
      .digest('hex'),
    host: createHash('sha256')
      .update(await readFile(binary))
      .digest('hex'),
  },
  requested_seconds: duration,
  elapsed_ms: Date.now() - began,
  completed_rounds: rounds,
  interrupted,
  ...(error ? { error } : {}),
  scope:
    'synthetic ACP/local temporary storage; real SIGKILL with explicit fixture-only stale socket cleanup; not live provider/Bot, OS sandbox, or automatic stale-socket recovery',
  phases,
};
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    passed: report.passed,
    completed_rounds: rounds,
    elapsed_ms: report.elapsed_ms,
    directory,
  }),
);
process.exitCode = report.passed ? 0 : interrupted ? 130 : 1;
