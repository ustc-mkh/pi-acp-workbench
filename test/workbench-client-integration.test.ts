// Real new host + TypeScript v2 client; synthetic ACP peer, isolated files, no account/model/Bot.
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchClient } from '../src/workbench-client';
import { WorkbenchSession } from '../src/workbench-session';
import {
  imageRef,
  type DomainEvent,
  type SessionId,
  type SessionSnapshot,
} from '../src/workbench-protocol';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function host(forkGate = false) {
  const root = await mkdtemp(join(tmpdir(), 'wb-ts-runtime-'));
  const data = join(root, 'data'),
    file = join(root, 'workbench.json'),
    trace = join(root, 'trace');
  const clients: WorkbenchClient[] = [];
  let process: ChildProcess | undefined, done: Promise<number | null> | undefined;
  await mkdir(join(root, 'home'));
  const config = {
    workers: {
      pi: {
        command: globalThis.process.execPath,
        args: [resolve('test/contract-agent.mjs')],
        env: {
          WORKBENCH_CONTRACT_NATIVE_STATE: join(root, 'native'),
          WORKBENCH_CONTRACT_TRACE: trace,
          ...(forkGate ? { WORKBENCH_CONTRACT_FORK_GATE: join(root, 'fork-gate') } : {}),
        },
      },
    },
    sessions: { mailbox: 128, max_workers: 1 },
    telegram: null,
    storage: { root: data },
    limits: { pending_interactions: 32 },
  };
  await writeFile(file, JSON.stringify(config));
  async function stop() {
    clients.splice(0).forEach((client) => client.dispose());
    if (!process || !done) return;
    const child = process,
      exited = done;
    process = undefined;
    done = undefined;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      expect(await exited).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  }
  cleanups.push(async () => {
    try {
      await stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  async function start() {
    const child = spawn(resolve('rust/target/debug/pi-acp-workbenchd'), ['--config', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: globalThis.process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8' },
    });
    process = child;
    done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    // An absent binary is a failed prerequisite, never a skipped integration.
    void done.catch(() => {});
    let output = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    await expect
      .poll(
        () => {
          if (child.exitCode !== null) throw new Error(output);
          return output.includes('ready:');
        },
        { timeout: 10000 },
      )
      .toBe(true);
  }
  const client = () => {
    const value = new WorkbenchClient(join(data, 'workbench.sock'));
    clients.push(value);
    return value;
  };
  const contents = async (dir: string): Promise<[string, string][]> => {
    const files: [string, string][] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...(await contents(join(dir, entry.name))));
      else files.push([join(dir, entry.name), await readFile(join(dir, entry.name), 'utf8')]);
    }
    return files.sort(([a], [b]) => a.localeCompare(b));
  };
  await start();
  return {
    root,
    data,
    client,
    stop,
    start,
    journal: () => contents(join(data, 'journal')),
    trace: () => readFile(trace, 'utf8'),
  };
}
function snapshot(events: DomainEvent[]): SessionSnapshot {
  for (const event of events) {
    if ('SessionCreated' in event) return event.SessionCreated;
    if ('SessionLoaded' in event) return event.SessionLoaded;
  }
  throw new Error('Snapshot absent');
}
async function turn(client: WorkbenchClient, session: SessionId, prompt: string) {
  await client.call({ method: 'subscribe', session });
  let unobserve = () => {};
  const completed = new Promise<void>((resolve) => {
    unobserve = client.observe({
      event(event) {
        if ('TurnFinished' in event && event.TurnFinished.session === session) resolve();
      },
    });
  });
  try {
    await client.call({ method: 'prompt', session, prompt });
    await completed;
    return snapshot(await client.call({ method: 'inspect', session }));
  } finally {
    unobserve();
  }
}

it('real new host streams typed text/tool/form DTOs into the authoritative TypeScript session view', async () => {
  const runtime = await host(),
    client = runtime.client();
  const created = snapshot(
    await client.call({ method: 'create', harness: 'Pi', cwd: runtime.root }),
  );
  const view = new WorkbenchSession(client, created.id);
  cleanups.push(() => view.stop());
  await view.start();
  const streamed = await turn(client, created.id, 'streamed-message');
  expect(streamed.transcript.entries.map((e) => e.text)).toEqual([
    'streamed-message',
    'reasoning',
    'hello ',
    '世界',
  ]);
  await expect.poll(() => view.view.snapshot?.revision).toBe(streamed.revision);
  expect(view.view.snapshot?.transcript.entries).toEqual(streamed.transcript.entries);
  expect(new Set(streamed.transcript.entries.slice(1).map((e) => e.message)).size).toBe(1);
  const tools = await turn(client, created.id, 'tool-metadata');
  expect(
    Object.values(tools.transcript.tools).flatMap((turn) => Object.values(turn)),
  ).not.toHaveLength(0);
  const prompt = client.call({ method: 'prompt', session: created.id, prompt: 'elicitation-text' });
  await prompt;
  await expect
    .poll(() => Object.keys(view.view.snapshot?.pending_interactions || {}).length)
    .toBe(1);
  const interaction = Object.values(view.view.snapshot!.pending_interactions)[0];
  expect(interaction.kind).toBe('Elicitation');
  await client.call({
    method: 'answer',
    session: created.id,
    answer: {
      interaction: interaction.id,
      response: { Form: { fields: { question_0: { Text: 'typed answer' } } } },
    },
  });
  await expect.poll(() => view.view.snapshot?.status).toBe('Idle');
  expect(view.view.snapshot?.pending_interactions).toEqual({});
  expect(view.view.error).toBeUndefined();
}, 20000);

it('real client reads exact immutable images after source removal/restart without journal or peer effects', async () => {
  const runtime = await host();
  let client = runtime.client();
  const created = snapshot(
    await client.call({ method: 'create', harness: 'Pi', cwd: runtime.root }),
  );
  const output = await turn(client, created.id, 'image-output');
  const ref = output.transcript.entries.find((e) => e.image)!.image!;
  const before = await runtime.journal(),
    trace = await runtime.trace();
  const asset = await client.call({ method: 'image', image: ref });
  expect(asset.image).toEqual(ref);
  await expect(
    client.call({ method: 'image', image: imageRef.parse({ ...ref, sha256: '0'.repeat(64) }) }),
  ).rejects.toMatchObject({ code: 'persistence', sideEffectPossible: false });
  expect(await runtime.journal()).toEqual(before);
  expect(await runtime.trace()).toBe(trace);
  await client.call({ method: 'remove', session: created.id });
  expect(await client.call({ method: 'image', image: ref })).toEqual(asset);
  await runtime.stop();
  await runtime.start();
  client = runtime.client();
  const restartedJournal = await runtime.journal(),
    restartedTrace = await runtime.trace();
  expect(await client.call({ method: 'image', image: ref })).toEqual(asset);
  expect(await runtime.journal()).toEqual(restartedJournal);
  expect(await runtime.trace()).toBe(restartedTrace);
}, 20000);

it('real exact fork cancellation targets the original operation and preserves uncertain remote effects', async () => {
  const runtime = await host(true),
    client = runtime.client();
  const created = snapshot(
    await client.call({ method: 'create', harness: 'Pi', cwd: runtime.root }),
  );
  const source = await turn(client, created.id, 'streamed-message');
  const entry = source.transcript.entries.find((e) => e.role === 'User')!.id;
  const command = { method: 'fork' as const, session: created.id, request: { entry } };
  const fork = client.request(command);
  // Attach the rejection observer before cancellation can settle the workflow.
  const failed = expect(fork.result).rejects.toMatchObject({
    code: 'native_fork_uncertain',
    operation: fork.operation,
  });
  await expect
    .poll(async () => {
      try {
        await readFile(join(runtime.root, 'fork-gate.started'));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const cancel = client.request({
    method: 'cancel_fork',
    session: created.id,
    operation: fork.operation!,
  });
  expect(cancel.operation).not.toBe(fork.operation);
  await Promise.all([
    expect(cancel.result).rejects.toMatchObject({
      code: 'native_fork_uncertain',
      operation: cancel.operation,
    }),
    failed,
  ]);
  const trace = await runtime.trace();
  await expect(client.call(command, { operation: fork.operation })).rejects.toMatchObject({
    code: 'native_fork_uncertain',
  });
  expect(await runtime.trace()).toBe(trace);
  expect(
    snapshot(await client.call({ method: 'inspect', session: created.id })).transcript,
  ).toEqual(source.transcript);
}, 20000);

it('real one-worker native fork returns typed independent origin and stable replay after source deletion/restart', async () => {
  const runtime = await host();
  let client = runtime.client();
  const created = snapshot(
    await client.call({ method: 'create', harness: 'Pi', cwd: runtime.root }),
  );
  const source = await turn(client, created.id, 'streamed-message');
  const entry = source.transcript.entries.find((e) => e.role === 'User')!.id;
  const command = { method: 'fork' as const, session: created.id, request: { entry } };
  const fork = client.request(command);
  expect(fork.operation).toBeDefined();
  const branch = snapshot(await fork.result);
  expect(branch.id).not.toBe(created.id);
  expect(branch.provider_session).not.toBe(source.provider_session);
  expect(branch.transcript.origin?.session).toBe(created.id);
  expect(branch.transcript.origin?.entry).toBe(entry);
  expect(
    snapshot(await client.call({ method: 'inspect', session: created.id })).transcript,
  ).toEqual(source.transcript);
  await client.call({ method: 'remove', session: created.id });
  await runtime.stop();
  await runtime.start();
  client = runtime.client();
  const trace = await runtime.trace();
  expect(snapshot(await client.call(command, { operation: fork.operation }))).toEqual(branch);
  expect(await runtime.trace()).toBe(trace);
}, 20000);
