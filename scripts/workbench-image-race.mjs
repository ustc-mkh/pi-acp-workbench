// Actual host / synthetic ACP: hold an incomplete IPC request while a gated
// image is archived and broadcast. This reproduces the select-cancellation
// interleaving, without claiming that a historical timeout has a unique cause.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WorkbenchWire, turnFinished } from '../test/helpers/workbench-wire.mjs';
import { imageArchive } from './lib/workbench-sqlite-fixture.mjs';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolveWorkbenchBinary(values.binary);
const root = await mkdtemp(join(tmpdir(), 'workbench-image-race-'));
const evidence = resolve('.test-results', `image-race-v1-${randomUUID()}`);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const report = {
  version: 1,
  binary_sha256: createHash('sha256')
    .update(await readFile(binary))
    .digest('hex'),
  scope:
    'Gated synthetic image; actual stdio, archive transaction, revision broadcast and fragmented IPC. No online provider or universal historical timeout diagnosis.',
  iterations: [],
  passed: false,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`image-race barrier timeout: ${label}`);
}

let host, done, control, observer, timer, failure;
let log = '';
try {
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'workspace'));
  const data = join(root, 'data'),
    gate = join(root, 'image-gate');
  const config = join(root, 'workbench.json');
  await writeFile(
    config,
    JSON.stringify({
      storage: { root: data },
      workers: {
        pi: {
          command: process.execPath,
          args: [resolve('test/contract-agent.mjs')],
          env: {
            WORKBENCH_CONTRACT_IMAGE_GATE: gate,
            WORKBENCH_CONTRACT_TRACE: join(evidence, 'provider.ndjson'),
          },
        },
      },
      sessions: { mailbox: 128, max_workers: 1 },
      limits: { pending_interactions: 32 },
      telegram: null,
    }),
    { mode: 0o600 },
  );
  host = spawn(binary, ['--config', config], {
    detached: true,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  done = new Promise((resolve, reject) => {
    host.once('error', reject);
    host.once('close', (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [host.stdout, host.stderr])
    stream.on('data', (chunk) => {
      log = (log + chunk).slice(-65536);
    });
  await until(async () => {
    assert.equal(host.exitCode, null, log);
    try {
      control = await WorkbenchWire.open(join(data, 'workbench.sock'));
      return true;
    } catch {
      return false;
    }
  }, 'host ready');
  observer = await WorkbenchWire.open(join(data, 'workbench.sock'));
  const session = (
    await control.call(
      { method: 'create', harness: 'Pi', cwd: join(root, 'workspace') },
      randomUUID(),
    )
  ).Created.summary.id;
  await control.call({ method: 'attach', session });
  await observer.call({ method: 'attach', session });
  for (let iteration = 0; iteration < 32; iteration++) {
    const trace = { iteration, started_at: Date.now() };
    const finished = control.waitFor((batch) => turnFinished(batch, session));
    // Attach handlers immediately, so a failed barrier cannot leave an unhandled
    // rejected waiter. Each owned wire is closed in the final cleanup.
    finished.catch(() => {});
    await control.call(
      { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'image-output' }] } },
      randomUUID(),
    );
    await until(
      () =>
        access(`${gate}.started`).then(
          () => true,
          () => false,
        ),
      'provider holds image',
    );
    trace.provider_held_at = Date.now();
    const command = { method: 'inspect', session };
    const id = ++observer.nextId;
    const frame = Buffer.from(JSON.stringify({ version: 3, id, command }) + '\n');
    const split = iteration % 2 ? frame.length - 1 : Math.floor(frame.length / 2);
    let replied = false;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        observer.pending.delete(id);
        reject(new Error('fragmented inspect timeout'));
      }, 15000);
      observer.pending.set(id, {
        resolve: (value) => {
          replied = true;
          resolve(value);
        },
        reject,
        timer: timeout,
      });
    });
    response.catch(() => {});
    const imageBatch = observer.waitFor(
      (batch) => batch.session === session && batch.entries.some((entry) => entry.image),
    );
    imageBatch.catch(() => {});
    observer.socket.write(frame.subarray(0, split));
    trace.prefix_sent_at = Date.now();
    // Allow the receiver to block in the incomplete read. The observable
    // barrier below is the broadcast before the suffix, not a timing claim.
    await delay(10);
    await writeFile(`${gate}.release`, 'release');
    trace.provider_released_at = Date.now();
    const batch = await imageBatch;
    trace.image_received_at = Date.now();
    trace.revision = batch.revision;
    const image = batch.entries.find((entry) => entry.image).image;
    const stored = imageArchive(data, image.id);
    assert.deepEqual(stored.image, image, 'full image identity is committed before broadcast');
    assert.equal(replied, false, 'unterminated request cannot be executed');
    // Concurrent complete replies on the other connection exercise the same
    // writer while the observer still has an incomplete frame.
    await Promise.all(
      Array.from({ length: 4 }, () => control.call({ method: 'history', session, limit: 10 })),
    );
    observer.socket.write(frame.subarray(split));
    trace.suffix_sent_at = Date.now();
    const view = await response;
    assert.equal(view.id, session);
    trace.inspect_received_at = Date.now();
    assert.deepEqual(await observer.call({ method: 'image', image }), stored);
    await finished;
    report.iterations.push(trace);
    await writeFile(join(evidence, 'trace.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  observer.close();
  observer = undefined;
  control.close();
  control = undefined;
  process.kill(-host.pid, 'SIGTERM');
  timer = setTimeout(() => {
    try {
      process.kill(-host.pid, 'SIGKILL');
    } catch {}
  }, 15000);
  report.shutdown = await done;
  assert.deepEqual(report.shutdown, { code: 0, signal: null }, log);
  report.passed = true;
} catch (error) {
  failure = error;
  report.error = String(error.stack || error);
} finally {
  clearTimeout(timer);
  control?.close();
  observer?.close();
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    try {
      process.kill(-host.pid, 'SIGKILL');
    } catch {}
    await done.catch(() => {});
  }
  await writeFile(join(evidence, 'host.log'), log, { mode: 0o600 });
  await writeFile(join(evidence, 'trace.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  await rm(root, { recursive: true, force: true });
}
console.log(`${report.passed ? 'PASS' : 'FAIL'} image / fragmented IPC barrier: ${evidence}`);
if (failure) throw failure;
