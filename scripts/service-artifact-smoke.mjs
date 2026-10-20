// Verify the single production pi-acp-workbenchd artifact with an isolated synthetic ACP peer.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { WorkbenchWire, inlineText } from '../test/helpers/workbench-wire.mjs';
import { assertStorageLayout } from './lib/workbench-sqlite-fixture.mjs';
import { releaseContract } from './lib/release-contract.mjs';

const { values } = parseArgs({ options: { dir: { type: 'string' }, report: { type: 'string' } } });
assert(values.dir, '--dir is required');
const directory = resolve(values.dir);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.production, true);
assert.deepEqual(manifest.contracts, releaseContract);
assert.deepEqual(manifest.features, []);
assert.equal(manifest.platform, 'linux');
assert.equal(manifest.arch, 'x64');
const expected = ['pi-acp-workbenchd'];
assert.deepEqual(Object.keys(manifest.files).sort(), expected);
for (const file of expected)
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(directory, file)))
      .digest('hex'),
    manifest.files[file],
  );
const root = await mkdtemp(join(tmpdir(), 'pi-workbench-artifact-'));
const children = [];
const checks = [];
const check = (message) => {
  checks.push(message);
  console.log(`ok   ${message}`);
};
const execute = (name, args, options = {}) => {
  const child = spawn(join(directory, name), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  child.output = '';
  child.errors = '';
  child.stdout.on('data', (chunk) => (child.output += chunk));
  child.stderr.on('data', (chunk) => (child.errors += chunk));
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  children.push(child);
  return child;
};
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    assert.equal(await child.done, 0, child.errors);
  } finally {
    clearTimeout(timer);
  }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, label, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child?.exitCode !== null) throw new Error(`${label}: ${child.errors}`);
    await delay(25);
  }
  throw new Error(`${label}: stdout=${child?.output || ''}; stderr=${child?.errors || ''}`);
}
let client;
try {
  const help = execute('pi-acp-workbenchd', ['--help']);
  assert.equal(await help.done, 0);
  assert(help.output.includes('--config'));
  check(`${manifest.target}: manifest hashes and single production entrypoint`);
  const workspace = join(root, 'workspace'),
    data = join(root, 'data'),
    home = join(root, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  const config = join(root, 'workbench.json');
  await writeFile(
    config,
    JSON.stringify({
      workers: {
        pi: { command: process.execPath, args: [resolve('test/contract-agent.mjs')], env: {} },
        codex: null,
        claude: null,
      },
      sessions: { mailbox: 128, max_workers: 1 },
      telegram: null,
      storage: { root: data },
      limits: { pending_interactions: 32 },
    }),
  );
  const launch = async () => {
    const child = execute('pi-acp-workbenchd', ['--config', config], {
      env: { ...process.env, HOME: home },
    });
    await until(
      () => `${child.output}\n${child.errors}`.includes('ready:'),
      'workbenchd ready',
      child,
    );
    client = await WorkbenchWire.open(join(data, 'workbench.sock'));
    return child;
  };
  let service = await launch();
  const created = await client.call({ method: 'create', harness: 'Pi', cwd: workspace });
  const sessionId = created.Created.summary.id;
  assert(sessionId);
  const prompt = { method: 'prompt', session: sessionId, prompt: 'artifact-acceptance' };
  const reply = await client.call(prompt, 'artifact-request');
  let inspected, entries;
  await until(
    async () => {
      inspected = await client.call({ method: 'inspect', session: sessionId });
      entries = (await client.call({ method: 'history', session: sessionId })).entries;
      return (
        inspected.active_turn === null &&
        entries.some((entry) => inlineText(entry) === 'echo: artifact-acceptance')
      );
    },
    'artifact prompt completion',
    service,
  );
  client.close();
  await stop(service);
  service = await launch();
  const restarted = await client.call({ method: 'inspect', session: sessionId });
  assert.equal(restarted.id, sessionId);
  assert.deepEqual((await client.call({ method: 'history', session: sessionId })).entries, entries);
  assert.deepEqual(await client.call(prompt, 'artifact-request'), reply);
  check(`${manifest.target}: worker, durable history, restart and no replay`);
  const activeMaintenance = execute('pi-acp-workbenchd', [
    'storage',
    'gc',
    '--root',
    data,
    '--confirm',
  ]);
  assert.notEqual(await activeMaintenance.done, 0, 'maintenance must respect the live host lease');
  client.close();
  await stop(service);
  const destination = join(root, 'export');
  assertStorageLayout(data);
  const exported = execute('pi-acp-workbenchd', [
    'storage',
    'export',
    '--root',
    data,
    '--destination',
    destination,
    '--confirm',
  ]);
  assert.equal(await exported.done, 0, exported.errors);
  const exportedManifest = JSON.parse(
    await readFile(join(destination, 'EXPORT-MANIFEST.json'), 'utf8'),
  );
  assert.equal(exportedManifest.format_version, 3);
  assert(exportedManifest.files.length > 0);
  assert(!exportedManifest.files.some((file) => file.path === '.workbench.lock'));
  for (const file of exportedManifest.files) {
    const original = await readFile(join(data, file.path));
    assert.deepEqual(await readFile(join(destination, file.path)), original);
    assert.equal(file.bytes, original.length);
    assert.equal(file.sha256, createHash('sha256').update(original).digest('hex'));
  }
  const compacted = execute('pi-acp-workbenchd', ['storage', 'gc', '--root', data, '--confirm']);
  assert.equal(await compacted.done, 0, compacted.errors);
  assert.deepEqual(JSON.parse(compacted.output), { removed_inbox: 0, removed_callbacks: 0 });
  check(
    `${manifest.target}: same-binary offline maintenance, live lease exclusion and byte/hash export`,
  );
  const badConfig = join(root, 'bad.json');
  await writeFile(
    badConfig,
    JSON.stringify({
      workers: {
        pi: { command: process.execPath, args: [resolve('test/contract-agent.mjs')], env: {} },
        codex: null,
        claude: null,
      },
      sessions: { mailbox: 128, max_workers: 1 },
      telegram: null,
      storage: { root: join(root, 'bad-data') },
      limits: { pending_interactions: 32 },
    }),
  );
  await mkdir(join(root, 'bad-data'));
  await writeFile(join(root, 'bad-data', 'legacy.bin'), 'old format');
  const malformed = execute('pi-acp-workbenchd', ['--config', badConfig]);
  await until(() => malformed.exitCode !== null, 'malformed shutdown', malformed);
  assert.notEqual(malformed.exitCode, 0);
  assert(!malformed.errors.includes('https://'));
  check(`${manifest.target}: invalid startup fails closed without credentials or remote URL`);
  if (values.report)
    await writeFile(
      values.report,
      JSON.stringify(
        {
          passed: true,
          target: manifest.target,
          contracts: manifest.contracts,
          checks,
          files: manifest.files,
          abi: manifest.abi,
        },
        null,
        2,
      ) + '\n',
    );
  console.log('PASS production artifact smoke');
} finally {
  client?.close();
  for (const child of children.reverse()) await stop(child);
  await rm(root, { recursive: true, force: true });
}
