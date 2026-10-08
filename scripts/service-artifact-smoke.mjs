// Verify an actual Linux x86_64 production package.
// All networking is loopback, including the rejected TLS connection via CONNECT.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ContractWire } from './lib/contract-wire.mjs';

const { values } = parseArgs({
  options: { dir: { type: 'string' }, report: { type: 'string' } },
});
assert(values.dir, '--dir is required');
const directory = resolve(values.dir),
  manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.production, true);
assert.deepEqual(manifest.features, []);
assert.equal(manifest.platform, 'linux');
assert.equal(manifest.arch, 'x64');
assert(['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'].includes(manifest.target));
const expected = [
  'pi-acp-session-daemon',
  'pi-acp-telegram-daemon',
  'pi-adapter.mjs',
  'pi-native-fork.mjs',
  'pi-fast-mode.mjs',
];
assert.deepEqual(Object.keys(manifest.files).sort(), expected.sort());
for (const file of expected)
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(directory, file)))
      .digest('hex'),
    manifest.files[file],
  );
const root = await mkdtemp(join(tmpdir(), 'pi-artifact-smoke-'));
const children = [],
  checks = [],
  sockets = new Set();
const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const execute = (name, args, options = {}) => {
  const binary = join(directory, name);
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.push(child);
  child.output = '';
  child.errors = '';
  child.stdout.on('data', (chunk) => (child.output = (child.output + chunk).slice(-16000)));
  child.stderr.on('data', (chunk) => (child.errors = (child.errors + chunk).slice(-16000)));
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  return child;
};
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    assert.equal(await child.done, 0, `shutdown failed: ${child.errors}`);
  } finally {
    clearTimeout(timeout);
  }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`artifact timeout: ${label}`);
}
const check = (text) => {
  checks.push(text);
  console.log(`ok   ${text}`);
};
let client, proxy, tlsServer;
try {
  for (const name of ['pi-acp-session-daemon', 'pi-acp-telegram-daemon']) {
    const child = execute(name, ['--help']);
    assert.equal(await child.done, 0);
    assert(child.output.includes('--config'), `help missing: ${name}`);
  }
  check(`${manifest.target}: manifest hashes and both production entrypoints`);
  const config = join(root, 'sessions.json'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(
    config,
    JSON.stringify({
      command: process.execPath,
      args: [resolve('test/contract-agent.mjs')],
      maxWorkers: 1,
      idleMs: 1000,
    }),
  );
  const launch = async () => {
    const child = execute('pi-acp-session-daemon', ['--config', config, '--data-dir', root]);
    await until(() => {
      if (child.exitCode !== null) throw new Error(child.errors);
      return child.output.includes('ready');
    }, 'production service ready');
    client = await ContractWire.open(join(root, 'service', 'sessions.sock'));
    return child;
  };
  let service = await launch();
  const session = await client.call('create', { cwd: workspace });
  const params = {
    sessionId: session.id,
    prompt: [{ type: 'text', text: 'artifact-acceptance' }],
    source: 'desktop',
  };
  const reply = await client.call('prompt', params, 'artifact-request');
  const entries = (await client.call('state', { sessionId: session.id })).snapshot.entries;
  assert(entries.some((entry) => entry.text === 'echo: artifact-acceptance'));
  client.close();
  await stop(service);
  service = await launch();
  assert.deepEqual(
    (await client.call('state', { sessionId: session.id })).snapshot.entries,
    entries,
  );
  assert.deepEqual(await client.call('prompt', params, 'artifact-request'), reply);
  client.close();
  await stop(service);
  check(`${manifest.target}: actual worker, durable history, restart and no replay`);
  const certificate = join(root, 'self-signed.pem'),
    key = join(root, 'self-signed.key');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=api.telegram.org',
      '-addext',
      'subjectAltName=DNS:api.telegram.org',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { stdio: 'ignore' },
  );
  let connects = 0,
    accepted = 0,
    rejected = 0,
    plain = 0;
  const tlsErrors = [];
  tlsServer = createTlsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (socket) => {
      accepted++;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    },
  );
  tlsServer.on('tlsClientError', (error) => {
    rejected++;
    tlsErrors.push({ code: error.code, message: error.message });
  });
  proxy = createServer((req, res) => {
    plain++;
    res.writeHead(500);
    res.end();
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, socket, head) => {
    assert.equal(request.url, 'api.telegram.org:443');
    connects++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    tlsServer.emit('connection', socket);
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  const telegram = join(root, 'telegram.json');
  await writeFile(
    telegram,
    JSON.stringify({ chatId: -1009999, allowedUserIds: [42], workspaces: { main: workspace } }),
  );
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const daemon = execute('pi-acp-telegram-daemon', ['--config', telegram, '--data-dir', root], {
    env: {
      ...process.env,
      PI_TELEGRAM_BOT_TOKEN: token,
      // Production must ignore mock endpoint and pacing, even when present.
      PI_TELEGRAM_API_BASE: proxyUrl,
      PI_TELEGRAM_PACE_MS: '1',
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: '',
      http_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
      SSL_CERT_FILE: certificate,
    },
  });
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 25000);
  try {
    assert.equal(await daemon.done, 1, `invalid certificate was accepted: ${daemon.errors}`);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(connects, 1);
  assert.equal(accepted, 0);
  assert.equal(plain, 0);
  await until(() => rejected === 1, 'TLS untrusted certificate rejection');
  assert(
    tlsErrors.some((error) => /unknown.ca/i.test(error.code + error.message)),
    `TLS failure must be a certificate rejection: ${JSON.stringify(tlsErrors)}`,
  );
  assert(daemon.errors.includes('网络请求失败'));
  assert(!daemon.errors.includes(token));
  assert(!daemon.errors.includes('https://'));
  check(
    `${manifest.target}: production official endpoint, TLS rejects untrusted certificate, token redacted`,
  );
  if (values.report) {
    await mkdir(resolve(values.report, '..'), { recursive: true });
    await writeFile(
      values.report,
      JSON.stringify(
        {
          passed: true,
          target: manifest.target,
          checks,
          files: manifest.files,
          abi: manifest.abi,
          tls: { connects, accepted, rejected, mockEndpointCalls: plain, errors: tlsErrors },
          mockBot: true,
          mockAcp: true,
        },
        null,
        2,
      ) + '\n',
    );
  }
  console.log('PASS production artifact smoke');
} finally {
  client?.close();
  for (const child of children.reverse()) await stop(child);
  for (const socket of sockets) socket.destroy();
  if (proxy?.listening) await new Promise((done) => proxy.close(done));
  tlsServer?.close();
  await rm(root, { recursive: true, force: true });
}
