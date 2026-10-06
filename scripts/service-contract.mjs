#!/usr/bin/env node
// Black-box contract suite for the session service wire protocol (docs/service-protocol.md)
// and disk formats (docs/data-formats.md). Drives a daemon over its Unix socket only —
// nothing is imported from src/, so the same suite validates the TypeScript daemon today
// and the Rust daemon later.
//
//   npm run test:contract
//   PI_CONTRACT_DAEMON="node dist/session-daemon.mjs" node scripts/service-contract.mjs
//   PI_CONTRACT_DAEMON="/path/to/rust-daemon" node scripts/service-contract.mjs
//
// The daemon must accept `--config <sessions.json>` and `--data-dir <dir>`.

import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const DAEMON = (process.env.PI_CONTRACT_DAEMON || `node ${resolve('dist/session-daemon.mjs')}`).split(/\s+/);
const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Minimal wire client per docs/service-protocol.md (reference implementation) ---
class Wire {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.events = [];
    this.fragments = null; this.fragmentCount = 0; this.closed = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let item; try { item = JSON.parse(line); } catch { return; }
        this.dispatch(item);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.onclose?.();
    });
    socket.on('error', () => {});
  }
  dispatch(item) {
    if (item && Object.hasOwn(item, 'fragment')) {
      if (this.fragments === null) this.fragments = [];
      this.fragmentCount++;
      this.fragments.push(item.fragment);
      if (item.last) {
        const body = this.fragments.join(''); this.fragments = null;
        this.dispatch(JSON.parse(body));
      }
      return;
    }
    if (this.fragments !== null) throw new Error('interleaved fragment stream');
    if (item && item.event !== undefined) { this.events.push(item.event); return; }
    const p = this.pending.get(item.id);
    if (!p) return;
    this.pending.delete(item.id); clearTimeout(p.timer);
    item.error !== undefined ? p.reject(new Error(item.error)) : p.resolve(item.value);
  }
  static async open(path) {
    const socket = createConnection(path);
    await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej); });
    return new Wire(socket);
  }
  call(method, params = {}, { id = randomUUID(), timeout = 15000 } = {}) {
    return new Promise((res, rej) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeout) : undefined;
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() { this.socket.destroy(); }
}

// --- daemon lifecycle -------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'pi-contract-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
execFileSync('git', ['init', '-q', workspace]);
const configFile = join(root, 'sessions.json');
await writeFile(configFile, JSON.stringify({
  maxWorkers: 2, idleMs: 60000,
  command: process.execPath, args: [resolve('test/contract-agent.mjs')],
  env: { PI_ACP_WORKBENCH_STATE_DIR: join(root, 'adapter-state') },
}), { mode: 0o600 });
const dataDir = join(root, 'data');
const socketPath = join(dataDir, 'service', 'sessions.sock');

let daemon;
function startDaemon() {
  const child = spawn(DAEMON[0], [...DAEMON.slice(1), '--config', configFile, '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write(`[daemon] ${d}`));
  daemon = child;
  return child;
}
async function waitSocket() {
  for (let i = 0; i < 200; i++) { if (existsSync(socketPath)) return; await delay(50); }
  throw new Error('daemon did not create sessions.sock');
}
async function stopDaemon(child = daemon) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(r => child.once('exit', r)), delay(10000)]);
}

// --- test harness -----------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const state = {};
const expectError = async (promise, pattern) => {
  try { await promise; } catch (e) { assert.match(e.message, pattern); return; }
  throw new Error(`expected error ${pattern}`);
};

test('hello advertises workbench capabilities', async () => {
  const c = state.client;
  const info = await c.call('hello');
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.agentCapabilities?.loadSession, true);
  assert.equal(info.agentCapabilities?._meta?.['pi-workbench']?.version, 1);
});

test('validation rejects malformed requests without destroying valid work', async () => {
  const c = state.client;
  await expectError(c.call('nope', { sessionId: 'x' }), /未知服务操作/);
  await expectError(c.call('state', {}), /sessionId/);
  await expectError(c.call('create', { cwd: 'relative/path' }), /绝对目录/);
  await expectError(c.call('prompt', { sessionId: 'x', prompt: [] }), /消息格式/);
  await expectError(c.call('request', { sessionId: 'x', method: 'session/prompt' }), /不支持的 ACP 操作/);
});

test('protocol violations destroy only the offending connection', async () => {
  // params:[] passes the wire check (typeof array === 'object') but fails service validation.
  const bad = await Wire.open(socketPath);
  const invalid = new Promise((res, rej) => bad.pending.set('a', { resolve: res, reject: rej }));
  bad.socket.write('{"id":"a","method":"hello","params":[]}\n');
  await expectError(invalid, /服务参数/);
  const recovered = await bad.call('hello');
  assert.equal(recovered.protocolVersion, 1);
  bad.close();
  // Malformed JSON and a non-string id must destroy the socket.
  for (const frame of ['not json\n', '{"id":123,"method":"hello","params":{}}\n']) {
    const conn = await Wire.open(socketPath);
    conn.socket.write(frame);
    await new Promise(r => conn.socket.once('close', r));
    assert(conn.closed);
  }
  // The healthy client still works.
  await state.client.call('hello');
});

test('oversized inbound frame destroys the connection', async () => {
  const big = await Wire.open(socketPath);
  const body = JSON.stringify({ id: 'big', method: 'hello', params: { pad: 'x'.repeat(17 * 1024 * 1024) } }) + '\n';
  big.socket.write(body);
  await new Promise(r => big.socket.once('close', r));
});

test('create returns absolute-path snapshots and allocates session numbers', async () => {
  const c = state.client;
  const s1 = await c.call('create', { cwd: workspace });
  assert.equal(typeof s1.id, 'string');
  assert.equal(s1.cwd, realpathSync(workspace));
  assert.equal(s1.sessionNumber, 1);
  assert.equal(s1.stored, true);
  const s2 = await c.call('create', { cwd: workspace });
  assert.notEqual(s2.id, s1.id);
  assert.equal(s2.sessionNumber, 2);
  state.sessionId = s1.id;
  const list = await c.call('list');
  assert.deepEqual(list.map(s => s.id).sort(), [s1.id, s2.id].sort());
  assert.ok(list.every(s => s.harness === 'pi' && Array.isArray(s.entries)));
});

test('state reads cold snapshots without spawning a worker', async () => {
  const s = await state.client.call('state', { sessionId: state.sessionId });
  assert.equal(s.snapshot.id, state.sessionId);
  assert.equal(s.busy, false);
  assert.deepEqual(s.snapshot.entries, []);
});

test('prompt completes a turn and records entries plus a diff card', async () => {
  const c = state.client;
  const result = await c.call('prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'hello' }], source: 'desktop' });
  assert.equal(result.stopReason, 'end_turn');
  const s = await c.call('state', { sessionId: state.sessionId });
  const roles = s.snapshot.entries.map(e => e.role);
  assert.ok(roles.includes('user') && roles.includes('assistant'));
  assert.ok(roles.includes('diff'), 'turn diff entry must be appended');
  assert.ok(s.snapshot.entries.find(e => e.role === 'assistant').text.includes('echo: hello'));
});

test('watchers receive session events; unsubscribed clients receive none', async () => {
  const watcher = await Wire.open(socketPath);
  const idle = await Wire.open(socketPath);
  try {
    assert.equal(await watcher.call('_watch', { sessionId: state.sessionId, enabled: true }), true);
    await watcher.call('prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'watched' }] });
    assert.ok(watcher.events.some(e => e.type === 'update' && e.notification.sessionId === state.sessionId));
    assert.ok(watcher.events.some(e => e.type === 'state' && e.snapshot.id === state.sessionId));
    await delay(100);
    assert.equal(idle.events.length, 0);
    assert.equal(await watcher.call('_watch', { sessionId: state.sessionId, enabled: false }), true);
  } finally { watcher.close(); idle.close(); }
});

test('permission requests surface in state and resolve via the permission method', async () => {
  const c = state.client;
  const pending = c.call('prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'permission' }] }, { timeout: 0 });
  let ticket;
  for (let i = 0; i < 100; i++) {
    const s = await c.call('state', { sessionId: state.sessionId });
    if (s.permissions.length) { ticket = s.permissions[0]; break; }
    await delay(50);
  }
  assert(ticket, 'permission never surfaced');
  assert.equal(ticket.request.options.some(o => o.optionId === 'yes'), true);
  assert.equal(await c.call('permission', { sessionId: state.sessionId, permissionId: ticket.id, optionId: 'yes' }), true);
  assert.equal(await c.call('permission', { sessionId: state.sessionId, permissionId: ticket.id, optionId: 'yes' }), false);
  const result = await pending;
  assert.equal(result.stopReason, 'end_turn');
});

test('cancel resolves a held prompt as cancelled', async () => {
  const c = state.client;
  const pending = c.call('prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'wait' }] }, { timeout: 0 });
  for (let i = 0; i < 100; i++) {
    const s = await c.call('state', { sessionId: state.sessionId });
    if (s.busy) break;
    await delay(50);
  }
  assert.equal(await c.call('cancel', { sessionId: state.sessionId }), true);
  const result = await pending;
  assert.equal(result.stopReason, 'cancelled');
});

test('duplicate request id returns the original result without re-executing', async () => {
  const c = state.client;
  const id = randomUUID();
  const first = await c.call('create', { cwd: workspace }, { id });
  const second = await c.call('create', { cwd: workspace }, { id });
  assert.equal(second.id, first.id);
  await expectError(c.call('create', { cwd: '/' }, { id }), /已被其他操作使用|冲突/);
});

test('state responses larger than 512 KiB arrive as reassemblable fragments', async () => {
  const c = state.client;
  const before = c.fragmentCount;
  await c.call('prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'big' }] });
  const s = await c.call('state', { sessionId: state.sessionId });
  assert.ok(c.fragmentCount > before, 'expected fragmented response');
  assert.ok(s.snapshot.entries.some(e => e.role === 'assistant' && e.text.length >= 600 * 1024));
});

test('daemon restart marks in-flight work interrupted and refuses replay', async () => {
  const c = state.client;
  const requestId = randomUUID();
  const prompt = [{ type: 'text', text: 'wait' }];
  const inflight = c.call('prompt', { sessionId: state.sessionId, prompt }, { id: requestId, timeout: 0 });
  inflight.catch(() => {});
  for (let i = 0; i < 100; i++) {
    const s = await c.call('state', { sessionId: state.sessionId }).catch(() => undefined);
    if (s?.busy) break;
    await delay(50);
  }
  await stopDaemon();
  const receipts = await readdir(join(dataDir, 'service', 'requests')).catch(() => []);
  assert.ok(receipts.length >= 1, 'durable receipt must exist before the restart');
  startDaemon(); await waitSocket();
  const c2 = state.client = await Wire.open(socketPath);
  const s = await c2.call('state', { sessionId: state.sessionId });
  assert.ok(s.error === undefined || s.error.includes('中断'), `unexpected state error: ${s.error}`);
  // Same request id must not re-execute: either the interrupted receipt rejects it
  // or a completed receipt returns the recorded result without running the worker.
  try {
    const value = await c2.call('prompt', { sessionId: state.sessionId, prompt }, { id: requestId });
    assert.equal(value.stopReason, 'cancelled');
  } catch (error) {
    assert.match(error.message, /重放|中断|已被其他操作使用/);
  }
});

test('a second daemon refuses the same data directory', async () => {
  const second = spawn(DAEMON[0], [...DAEMON.slice(1), '--config', configFile, '--data-dir', dataDir], { stdio: ['ignore', 'ignore', 'ignore'] });
  const code = await Promise.race([new Promise(r => second.once('exit', r)), delay(8000).then(() => 'timeout')]);
  assert.notEqual(code, 'timeout', 'second daemon must fail fast instead of taking over');
  assert.notEqual(code, 0);
  if (code === 'timeout') second.kill('SIGKILL');
});

test('remove deletes the session from history and rejects further state', async () => {
  const c = state.client;
  await c.call('remove', { sessionId: state.sessionId });
  const list = await c.call('list');
  assert.ok(!list.some(s => s.id === state.sessionId));
  await expectError(c.call('state', { sessionId: state.sessionId }), /不存在|删除/);
});

// --- runner -----------------------------------------------------------------
let failures = 0;
try {
  startDaemon();
  await waitSocket();
  state.client = await Wire.open(socketPath);
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failures++; console.log(`FAIL ${name}\n     ${error.stack || error}`); }
  }
} finally {
  state.client?.close();
  await stopDaemon();
  await rm(root, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} contract test(s) failed` : `\n${tests.length} contract tests passed`);
process.exitCode = failures ? 1 : 0;
