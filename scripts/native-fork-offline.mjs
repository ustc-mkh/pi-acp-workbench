// Opt-in real Pi CLI/SDK native-format acceptance, with synthetic local history.
// Never inherit account credentials/configuration or send a model request.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, copyFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = process.env.PI_OFFLINE_PI_CLI;
if (!cli || !isAbsolute(cli) || !(await stat(cli)).isFile())
  throw new Error(
    'Set PI_OFFLINE_PI_CLI to an installed Pi dist/cli.js; no automatic installation or real credentials are used.',
  );
if (process.platform !== 'linux')
  throw new Error('This offline process-ownership check currently requires Linux /proc.');
const sdk = JSON.parse(await readFile(join(dirname(dirname(cli)), 'package.json'), 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'workbench-pi-offline-'));
const trace = join(root, 'trace.ndjson');
const report = join(root, 'native-report.json');
const wrapper = join(root, 'pi-offline');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let child;
let failure;
let output = '';
const records = async () =>
  (await readFile(trace, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function ownedAlive(pid) {
  try {
    return (await readFile(`/proc/${pid}/environ`, 'utf8'))
      .split('\0')
      .includes(`WORKBENCH_OFFLINE_TRACE=${trace}`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}
try {
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'agent'));
  const cargoHome = join(root, 'cargo');
  await mkdir(cargoHome);
  // Share cached dependency sources, never credential/config files. Cargo itself
  // is explicitly --offline in the nested fixture command.
  await symlink(
    join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry'),
    join(cargoHome, 'registry'),
    'dir',
  );
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} --offline --no-approve --no-extensions --no-mcp --no-context-files --no-skills --no-prompt-templates "$@"\n`,
    { mode: 0o700 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TMPDIR: root,
    LANG: 'C.UTF-8',
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1',
    PI_ACP_PI_COMMAND: wrapper,
    PI_PROVIDER: 'anthropic',
    PI_MODEL: 'claude-sonnet-4-5',
    PI_NATIVE_FUTURE_MODEL: 'claude-opus-4-5',
    PI_NATIVE_API: 'anthropic-messages',
    // A public dummy makes local catalog selection deterministic. It is never
    // sent anywhere: all ordinary Node network entrypoints are asserted below.
    ANTHROPIC_API_KEY: 'offline-fixture-not-a-credential',
    NODE_OPTIONS: `--import=${pathToFileURL(resolve('test/helpers/offline-network-guard.mjs'))}`,
    WORKBENCH_OFFLINE_TRACE: trace,
    PI_NATIVE_FORK_REPORT: report,
    PI_OFFLINE_RUST_HOST: '1',
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: join(root, 'rust-target'),
  };
  // Compilation is a separate phase, not part of the CLI/native-operation
  // deadline. Freeze the actual test executable before starting any SDK peer.
  // A loaded machine must not misreport a fresh Rust build as an RPC timeout.
  const compileStart = performance.now();
  child = spawn(
    'cargo',
    [
      'test',
      '--offline',
      '--locked',
      '--manifest-path',
      resolve('rust/Cargo.toml'),
      '-p',
      'pi-acp-workbenchd',
      '--lib',
      '--no-run',
      '--message-format=json',
    ],
    {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let compilerOutput = '',
    compilerErrors = '';
  child.stdout.on('data', (chunk) => {
    compilerOutput += chunk;
  });
  child.stderr.on('data', (chunk) => {
    compilerErrors = (compilerErrors + chunk).slice(-65536);
  });
  const compiled = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(compiled, { code: 0, signal: null }, compilerErrors);
  const artifact = compilerOutput
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .find(
      (item) =>
        item.reason === 'compiler-artifact' && item.executable && item.target.kind.includes('lib'),
    );
  assert(artifact?.executable, 'offline Rust test executable missing');
  env.PI_OFFLINE_RUST_TEST_BINARY = join(root, 'workbench-sdk-tests');
  await copyFile(artifact.executable, env.PI_OFFLINE_RUST_TEST_BINARY);
  console.log(
    JSON.stringify({ offlineCompileMs: performance.now() - compileStart, sdkProcessesStarted: 0 }),
  );
  // Prove the assertion hook is active before using it as negative evidence.
  const probe = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "try { await fetch('http://127.0.0.1:1'); process.exitCode = 1; } catch {}",
    ],
    { env, stdio: 'ignore' },
  );
  assert.equal(
    await new Promise((done, reject) => {
      probe.once('error', reject);
      probe.once('exit', done);
    }),
    0,
  );
  assert.deepEqual(
    (await records()).filter((record) => record.type === 'network').map((record) => record.method),
    ['fetch'],
  );
  await writeFile(trace, ''); // Only this fixture's completed probe is discarded.
  child = spawn(process.execPath, [resolve('scripts/native-fork-smoke.mjs')], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', (text) => {
    const combined = output + text;
    output = combined.slice(0, 128 * 1024);
    if (combined.length > output.length) child.kill('SIGTERM');
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr = (stderr + text).slice(-64 * 1024);
  });
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }, 180000);
  const result = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(
    result.code,
    0,
    `offline native-format check failed (${result.signal ?? result.code}):\n${stderr}\n${output}`,
  );
  const booted = (await records()).filter((record) => record.type === 'boot');
  const deadline = Date.now() + 5000;
  while (
    (await Promise.all(booted.map(({ pid }) => ownedAlive(pid)))).some(Boolean) &&
    Date.now() < deadline
  )
    await delay(20);
  assert.ok(
    !(await Promise.all(booted.map(({ pid }) => ownedAlive(pid)))).some(Boolean),
    'offline Pi descendants outlived their joined script',
  );
  assert.ok(booted.length >= 18, 'guard must cover SDK helpers and the new Rust host ACP peers');
  assert.equal(
    (await records()).filter((record) => record.type === 'network').length,
    0,
    'offline native operations attempted network',
  );
  const evidence = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(evidence.rustHost?.historicalSettings, true);
  assert.equal(evidence.rustHost?.durableRestartReplay, true);
  assert.equal(evidence.forkResponses.length, 1);
  assert.ok(evidence.inspection.forkPoints.length >= 6);
  assert.ok(
    evidence.inspection.forkPoints.some((point) => !point.safe && point.hash === ''),
    'real adapter must expose unsafe intermediate tool points',
  );
  if (process.env.PI_OFFLINE_RECORD)
    await writeFile(
      resolve(process.env.PI_OFFLINE_RECORD),
      JSON.stringify(
        {
          provenance: {
            sdk: sdk.name,
            version: sdk.version,
            syntheticHistory: true,
            networkAttempts: 0,
            realModelRequests: 0,
            scope:
              'real Pi CLI, bundled ACP adapter and new Rust WorkbenchApp; synthetic history only',
          },
          ...evidence,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  console.log(output.trim());
  console.log(
    JSON.stringify({
      sdk: sdk.name,
      version: sdk.version,
      guardedProcesses: new Set(booted.map(({ pid }) => pid)).size,
      networkAttempts: 0,
      realModelRequests: 0,
      nativeFormat: true,
      newRustHost: true,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  // Only PIDs marked by this independently generated fixture environment may be
  // terminated; no broad name matching or real user directories are touched.
  const pids = [
    ...new Set((await records()).filter((record) => record.type === 'boot').map(({ pid }) => pid)),
  ];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of pids)
      if (await ownedAlive(pid)) {
        try {
          process.kill(-pid, signal);
        } catch {}
        try {
          process.kill(pid, signal);
        } catch {}
      }
    await delay(100);
  }
  assert.ok(
    !(await Promise.all(pids.map(ownedAlive))).some(Boolean),
    `offline fixture cleanup failed; preserve ${root}`,
  );
  await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
