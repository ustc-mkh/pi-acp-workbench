// Exercise real process cleanup during startup, not only unit constructors.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as unixServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';
const root = await mkdtemp(join(tmpdir(), 'workbench-startup-'));
const binary = process.env.PI_WORKBENCHD_BIN || resolve('rust/target/debug/pi-acp-workbenchd');
const children = new Set();
let behavior = 'hold';
let called;
const server = createServer((request, response) => {
  request.resume();
  called?.();
  if (behavior === 'fail') {
    response.writeHead(401);
    response.end('{"ok":false,"error_code":401}');
  } else if (behavior === 'ok') {
    response.writeHead(200);
    response.end(
      '{"ok":true,"result":{"id":99,"is_bot":true,"first_name":"fixture","username":"fixture_bot"}}',
    );
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = {
  workers: {
    pi: { command: process.execPath, args: [resolve('test/contract-agent.mjs')], env: {} },
  },
  sessions: { mailbox: 128, max_workers: 1 },
  storage: { root: join(root, 'data') },
  limits: { pending_interactions: 32 },
  telegram: {
    bot_token_env: 'STARTUP_FIXTURE_TOKEN',
    workspace: root,
    allowed_chat_ids: [-100],
    allowed_user_ids: [5],
    api_base: `http://127.0.0.1:${server.address().port}/`,
    inbox_capacity: 128,
  },
};
const file = join(root, 'config.json');
function launch() {
  const child = spawn(binary, ['--config', file], {
    env: { ...process.env, STARTUP_FIXTURE_TOKEN: 'startup-fixture-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.output = '';
  child.stdout.on('data', (data) => (child.output += data));
  child.stderr.on('data', (data) => (child.output += data));
  child.done = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      done({ code, signal });
    });
  });
  return child;
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(
        (_, reject) =>
          (timer = setTimeout(() => reject(new Error('startup cleanup timeout')), 12000)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function absentSocket() {
  await assert.rejects(stat(join(base.storage.root, 'workbench.sock')), { code: 'ENOENT' });
}
try {
  await writeFile(file, JSON.stringify(base));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const requested = new Promise((done) => (called = done));
    const child = launch();
    await bounded(requested);
    child.kill(signal);
    assert.deepEqual(await bounded(child.done), { code: 0, signal: null });
    assert(!child.output.includes('startup-fixture-secret'));
    await absentSocket();
    console.log(`ok   ${signal} during blocked getMe joins database/runtime before lease release`);
  }
  behavior = 'fail';
  const failed = launch();
  assert.notEqual((await bounded(failed.done)).code, 0);
  await absentSocket();
  assert(!failed.output.includes('startup-fixture-secret'));
  console.log('ok   failed Telegram initialization releases the same storage lease');
  // A real listening socket must be retained, never silently removed as stale.
  const socket = join(base.storage.root, 'workbench.sock');
  const blocker = unixServer();
  await new Promise((done) => blocker.listen(socket, done));
  const noTelegram = { ...base, telegram: null };
  await writeFile(file, JSON.stringify(noTelegram));
  const failedBind = launch();
  assert.notEqual((await bounded(failedBind.done)).code, 0);
  assert((await stat(socket)).isSocket());
  await new Promise((done) => blocker.close(done));
  console.log('ok   IPC bind failure joins runtime and preserves the preexisting socket');
  const recovered = launch();
  await bounded(
    new Promise((done) => {
      const check = () => (recovered.output.includes('ready:') ? done() : setTimeout(check, 10));
      check();
    }),
  );
  const wire = await WorkbenchWire.open(socket);
  assert.deepEqual((await wire.call({ method: 'list' })).sessions, []);
  wire.close();
  recovered.kill('SIGTERM');
  assert.deepEqual(await bounded(recovered.done), { code: 0, signal: null });
  await absentSocket();
  console.log(
    'PASS startup cleanup: fresh host reacquires lease and serves v3 after every failure',
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => child.done));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
