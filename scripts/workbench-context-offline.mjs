// Opt-in real Pi registry + models.json acceptance. No model prompt or account configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';
const cli = process.env.PI_OFFLINE_PI_CLI;
assert(cli && isAbsolute(cli) && (await stat(cli)).isFile(), 'Set PI_OFFLINE_PI_CLI explicitly');
const root = await mkdtemp(join(tmpdir(), 'workbench-context-offline-'));
const profile = join(root, 'profile'),
  home = join(root, 'home'),
  data = join(root, 'data');
const file = join(profile, 'models.json'),
  trace = join(root, 'network.ndjson');
const model = 'fixture/context-model';
const report = { root, cli, checks: [], exits: [] };
const binary = resolve(process.env.WORKBENCH_TEST_BINARY || 'rust/target/debug/pi-acp-workbenchd');
let host,
  wire,
  output = '',
  failed = true;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function start() {
  host = spawn(binary, ['--config', join(root, 'config.json')], {
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  output = '';
  for (const stream of [host.stdout, host.stderr])
    stream.on('data', (b) => {
      output = (output + b).slice(-65536);
    });
  host.done = new Promise((done, reject) => {
    host.once('error', reject);
    host.once('exit', (code, signal) => done({ code, signal }));
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('ready:')) {
    assert(host.exitCode === null && Date.now() < deadline, output);
    await delay(10);
  }
  wire = await WorkbenchWire.open(join(data, 'workbench.sock'));
}
async function stop() {
  wire?.close();
  wire = undefined;
  if (!host) return;
  host.kill('SIGTERM');
  const timer = setTimeout(() => host.kill('SIGKILL'), 10000);
  const exit = await host.done.finally(() => clearTimeout(timer));
  report.exits.push(exit);
  assert.deepEqual(exit, { code: 0, signal: null }, output);
  host = undefined;
}
async function observed(session, expected) {
  const settings = await wire.call({ method: 'management', query: { session } });
  const row = settings.models.find((m) => m.harness === 'Pi' && m.model === model);
  assert.equal(row?.context_window, expected);
  assert.equal(row?.context_state, 'applied');
  return row;
}
try {
  for (const dir of [profile, home, join(root, 'one'), join(root, 'two')]) await mkdir(dir);
  await writeFile(
    file,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: 'http://127.0.0.1:9',
          api: 'openai-completions',
          apiKey: 'offline-fixture-only',
          models: [
            {
              id: 'context-model',
              name: 'Context fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fixture',
      defaultModel: 'context-model',
      packages: [],
      extensions: [],
      skills: [],
      promptTemplates: [],
    }),
  );
  const wrapper = join(root, 'pi-offline');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} --offline --no-approve --no-extensions --no-mcp --no-context-files --no-skills --no-prompt-templates "$@"\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      workers: {
        pi: {
          command: process.execPath,
          args: [resolve('dist/pi-adapter.mjs')],
          env: {
            HOME: home,
            PI_CODING_AGENT_DIR: profile,
            PI_ACP_PI_COMMAND: wrapper,
            PI_ACP_WORKBENCH_STATE_DIR: join(root, 'adapter-state'),
            NODE_OPTIONS: `--import=${pathToFileURL(resolve('test/helpers/offline-network-guard.mjs'))}`,
            WORKBENCH_OFFLINE_TRACE: trace,
          },
        },
      },
      storage: { root: data },
      sessions: { mailbox: 128, max_workers: 2 },
      limits: { pending_interactions: 32 },
    }),
  );
  await start();
  const sessions = [];
  for (const name of ['one', 'two']) {
    const created = await wire.call({ method: 'create', harness: 'Pi', cwd: join(root, name) });
    sessions.push(created.Created.summary.id);
    await wire.call({ method: 'discover', session: sessions.at(-1) });
  }
  for (const [index, value] of [256000, 320000].entries()) {
    await wire.call(
      {
        method: 'manage',
        session: sessions[index],
        action: { action: 'context', model, context_window: value },
      },
      `offline-context-${index}`,
    );
    await observed(sessions[index], value);
    assert.equal(
      JSON.parse(await readFile(file, 'utf8')).providers.fixture.modelOverrides['context-model']
        .contextWindow,
      value,
    );
  }
  const checkpoint = JSON.parse(await readFile(file + '.workbench-context.json', 'utf8'));
  assert.equal(checkpoint.revision, 2);
  assert.equal(checkpoint.state, 'applied');
  report.checks.push('two actual Pi workers share versioned profile overrides across workspaces');
  await stop();
  await start();
  await wire.call({ method: 'discover', session: sessions[0] });
  await observed(sessions[0], 320000);
  report.checks.push('daemon and Pi restart retain context through actual registry reload');
  await wire.call(
    {
      method: 'manage',
      session: sessions[0],
      action: { action: 'context', model, context_window: null },
    },
    'offline-context-reset',
  );
  await observed(sessions[0], 200000);
  const final = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(final.providers.fixture.modelOverrides, undefined);
  assert.equal(final.providers.fixture.apiKey, 'offline-fixture-only');
  report.checks.push(
    'clear override restores actual Pi default and preserves unrelated provider fields',
  );
  await stop();
  const records = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(records.some((r) => r.type === 'boot'));
  assert.equal(records.filter((r) => r.type === 'network').length, 0);
  report.guarded_processes = records.length;
  report.checks.push('no model prompts, guarded Node network calls or account configuration');
  failed = false;
} catch (error) {
  report.error = String(error);
  await writeFile(join(root, 'host.log'), output);
  throw error;
} finally {
  await stop();
  const evidence = resolve(
    process.env.WORKBENCH_CONTEXT_REPORT || '.test-results/context-offline.json',
  );
  await writeFile(evidence, JSON.stringify({ ...report, passed: !failed }, null, 2) + '\n');
  if (!failed) await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: !failed, evidence, retained_root: failed ? root : null }));
}
