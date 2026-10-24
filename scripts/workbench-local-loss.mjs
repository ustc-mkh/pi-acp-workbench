// Test-owned roots only. Actual SIGKILL cuts complement provider/HTTP loss windows.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchWire, turnFinished } from '../test/helpers/workbench-wire.mjs';
import { operationRecords } from './lib/workbench-sqlite-fixture.mjs';
const { values } = parseArgs({
  options: { binary: { type: 'string' }, report: { type: 'string' } },
});
assert(values.binary && values.report);
const binary = resolve(values.binary),
  peer = resolve('test/contract-agent.mjs');
const root = await mkdtemp(join(tmpdir(), 'workbench-local-loss-')),
  data = join(root, 'data'),
  workspace = join(root, 'workspace'),
  home = join(root, 'home'),
  socket = join(data, 'workbench.sock');
await mkdir(workspace);
await mkdir(home);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  version: 1,
  passed: false,
  binary_sha256: sha(await readFile(binary)),
  runner_sha256: sha(await readFile(new URL(import.meta.url))),
  fixture_sha256: sha(await readFile(peer)),
  windows: [],
  hosts: [],
  scope:
    'Actual isolated SIGKILL of local mutation before commit/after commit without receipt observation, and undo filesystem publication after failed settlement. Not an arbitrary mid-file publication barrier or online provider test.',
};
const config = join(root, 'config.json');
await writeFile(
  config,
  JSON.stringify({
    workers: {
      pi: {
        command: process.execPath,
        args: [peer],
        env: { WORKBENCH_CONTRACT_WORKSPACE_FILE: join(workspace, 'modified.txt') },
      },
    },
    sessions: { mailbox: 128, max_workers: 1 },
    telegram: null,
    storage: { root: data },
    limits: { pending_interactions: 32 },
  }),
);
let host, wire;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error('timeout ' + label);
}
async function start() {
  host = spawn(binary, ['--config', config], {
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.output = '';
  host.stdout.on('data', (b) => (host.output += b));
  host.stderr.on('data', (b) => (host.output += b));
  host.done = new Promise((r, j) => {
    host.once('error', j);
    host.once('exit', (code, signal) => {
      host.closed = true;
      report.hosts.push({ pid: host.pid, code, signal, output: host.output });
      r({ code, signal });
    });
  });
  await until(() => {
    assert(!host.closed, host.output);
    return host.output.includes('ready:');
  }, 'ready');
  wire = await WorkbenchWire.open(socket);
}
async function kill() {
  wire.close();
  wire = undefined;
  const inode = await lstat(socket);
  host.kill('SIGKILL');
  assert.deepEqual(await host.done, { code: null, signal: 'SIGKILL' });
  const current = await lstat(socket);
  assert.equal(current.ino, inode.ino);
  assert(current.isSocket());
  await unlink(socket);
}
async function stop() {
  wire?.close();
  wire = undefined;
  if (host && !host.closed) {
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 8000);
    try {
      assert.deepEqual(await host.done, { code: 0, signal: null });
    } finally {
      clearTimeout(timer);
    }
  }
}
function db() {
  return new DatabaseSync(join(data, 'workbench.sqlite3'));
}
function sendUnobserved(command, operation) {
  wire.socket.write(JSON.stringify({ version: 3, id: 999999, command, operation }) + '\n');
}
try {
  await start();
  const session = (await wire.call({ method: 'create', harness: 'Pi', cwd: workspace })).Created
    .summary.id;
  // SQLite writer lock makes this a pre-commit cut, not a timing-based guess.
  let sql = db();
  sql.exec('BEGIN IMMEDIATE');
  const before = 'local-before-commit';
  const rename = {
    method: 'manage',
    session,
    action: { action: 'rename', title: 'P6_BEFORE_COMMIT' },
  };
  sendUnobserved(rename, before);
  await delay(100);
  await kill();
  sql.exec('ROLLBACK');
  sql.close();
  await start();
  assert.equal(operationRecords(data, before).length, 0);
  sql = db();
  assert.equal(
    sql.prepare('SELECT count(*) AS n FROM session_metadata WHERE title=?').get('P6_BEFORE_COMMIT')
      .n,
    0,
  );
  sql.close();
  report.windows.push({
    name: 'local-rename-before-commit',
    operation: before,
    operation_rows: 0,
    scope: 'writer-locked uncommitted command, no completion invented',
  });
  const operation = 'local-after-commit';
  const command = {
    method: 'manage',
    session,
    action: { action: 'rename', title: 'P6_DURABLE_RENAME' },
  };
  sendUnobserved(command, operation);
  await until(() => operationRecords(data, operation)[0]?.status === 'Completed', 'rename commit');
  const row = operationRecords(data, operation)[0];
  const receipt = JSON.parse(row.result.toString()).Ok;
  await kill();
  await start();
  assert.equal((await wire.call({ method: 'operation', operation })).status, 'completed');
  assert.deepEqual(await wire.call(command, operation), receipt);
  assert.equal(operationRecords(data, operation).length, 1);
  sql = db();
  assert.equal(
    sql.prepare('SELECT title FROM session_metadata WHERE session=?').get(session).title,
    'P6_DURABLE_RENAME',
  );
  sql.close();
  report.windows.push({
    name: 'local-rename-after-commit-before-receipt-observation',
    operation,
    receipt,
    exact_replay: true,
  });
  // Real provider shell mutation produces a frozen complete Diff in a Git workspace.
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  await writeFile(join(workspace, 'modified.txt'), 'before\n');
  execFileSync('git', ['add', 'modified.txt'], { cwd: workspace });
  await wire.call({ method: 'attach', session });
  const finished = wire.waitFor((b) => turnFinished(b, session));
  await wire.call(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'workspace-write' }] } },
    'local-diff-turn',
  );
  await finished;
  const history = await wire.call({ method: 'history', session });
  const turn = history.entries.find((e) => e.role === 'User').turn;
  const diff = await wire.call({ method: 'turn_diff', session, turn });
  assert.equal(diff.status, 'complete');
  assert.equal(diff.files.length, 1);
  assert.equal(await readFile(join(workspace, 'modified.txt'), 'utf8'), 'after\n');
  const undo = 'undo-lost-settlement';
  sql = db();
  sql.exec(
    "CREATE TRIGGER p6_fail_settle BEFORE UPDATE ON operations WHEN OLD.operation='undo-lost-settlement' BEGIN SELECT RAISE(FAIL, 'P6 settlement unavailable'); END;",
  );
  const undoCommand = { method: 'undo_turn', session, turn };
  await assert.rejects(wire.call(undoCommand, undo));
  assert.equal(await readFile(join(workspace, 'modified.txt'), 'utf8'), 'before\n');
  assert.equal(operationRecords(data, undo)[0].status, 'Started');
  await kill();
  sql.exec('DROP TRIGGER p6_fail_settle');
  sql.close();
  await writeFile(join(workspace, 'modified.txt'), 'after\n');
  await start();
  assert.equal((await wire.call({ method: 'operation', operation: undo })).status, 'uncertain');
  await assert.rejects(wire.call(undoCommand, undo), /operation_interrupted/);
  assert.equal(await readFile(join(workspace, 'modified.txt'), 'utf8'), 'after\n');
  report.windows.push({
    name: 'undo-files-published-settlement-failed-then-SIGKILL',
    operation: undo,
    status: 'uncertain',
    no_filesystem_replay: true,
    scope: 'exact SQLite failure after filesystem publication; not a controlled partial-file cut',
  });
  await stop();
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  report.retained_root = root;
  process.exitCode = 1;
} finally {
  await stop();
  await mkdir(resolve(values.report, '..'), { recursive: true });
  await writeFile(resolve(values.report), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed: report.passed,
    windows: report.windows.length,
    report: resolve(values.report),
  }),
);
