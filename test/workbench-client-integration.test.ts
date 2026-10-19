// Real v3 host + TypeScript client; synthetic ACP peer, isolated files, no account/model/Bot.
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { operationRecords } from '../scripts/lib/workbench-sqlite-fixture.mjs';
import { WorkbenchClient } from '../src/workbench-client';
import { WorkbenchSession } from '../src/workbench-session';
import { WorkbenchController } from '../src/workbench-controller';
import { exportMarkdown } from '../src/workbench-export';
import { imageRef, operationId, type SessionId } from '../src/workbench-protocol';

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
  async function stop(disposeClients = true) {
    if (disposeClients) clients.splice(0).forEach((client) => client.dispose());
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
  await start();
  return {
    root,
    data,
    client,
    stop,
    disconnect: () => stop(false),
    start,
    journal: () => operationRecords(data),
    trace: () => readFile(trace, 'utf8'),
  };
}
async function create(client: WorkbenchClient, cwd: string) {
  const receipt = await client.call({ method: 'create', harness: 'Pi', cwd });
  if (!('Created' in receipt)) throw new Error('Created summary absent');
  return receipt.Created.summary;
}
async function turn(client: WorkbenchClient, session: SessionId, prompt: string) {
  await client.call({ method: 'attach', session });
  let unobserve = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    unobserve = client.observe({
      batch(batch) {
        if (batch.session !== session || !batch.view) return;
        if (typeof batch.view.status === 'object') reject(new Error(batch.view.status.Failed));
        if (batch.view.status === 'Idle' && !batch.view.active_turn) resolve();
      },
    });
  });
  try {
    await client.call({ method: 'prompt', session, prompt });
    await completed;
    return {
      view: await client.call({ method: 'inspect', session }),
      page: await client.call({ method: 'history', session }),
    };
  } finally {
    unobserve();
  }
}

it('controller reattaches after a real daemon restart without replay, provider load or journal writes', async () => {
  const runtime = await host();
  const client = runtime.client();
  const created = await create(client, runtime.root);
  await turn(client, created.id, 'streamed-message');
  const controller = new WorkbenchController(runtime.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => runtime.root,
    authorize: async () => {
      throw new Error('Recovery cannot authorize a mutation');
    },
  });
  cleanups.push(async () => controller.dispose());
  await controller.receive({ type: 'select', session: created.id });
  expect(controller.snapshot.view?.status).toBe('ready');
  const revision = controller.snapshot.view!.view!.revision;
  const journal = await runtime.journal();
  await runtime.disconnect();
  await expect.poll(() => controller.snapshot.view?.status).toBe('disconnected');
  // Graceful host shutdown may emit session/cancel while physically joining the worker.
  // Recovery itself must add no provider traffic.
  const trace = await runtime.trace();
  await runtime.start();
  await expect.poll(() => controller.snapshot.view?.status, { timeout: 10000 }).toBe('ready');
  expect(controller.snapshot.selected).toBe(created.id);
  expect(controller.snapshot.view?.view?.revision).toBe(revision);
  expect(
    controller.snapshot.view?.entries.some(
      (entry) => 'Inline' in entry.text && entry.text.Inline.text === 'streamed-message',
    ),
  ).toBe(true);
  expect(await runtime.journal()).toEqual(journal);
  expect(await runtime.trace()).toBe(trace);
}, 20000);

it('exports a cold committed transcript after restart without provider load or operation writes', async () => {
  const runtime = await host();
  const client = runtime.client();
  const created = await create(client, runtime.root);
  await turn(client, created.id, 'streamed-message');
  await runtime.stop();
  await runtime.start();
  const before = await runtime.journal();
  const trace = await runtime.trace();
  let markdown = '';
  for await (const chunk of exportMarkdown(runtime.client(), created.id)) markdown += chunk;
  expect(markdown).toContain('streamed-message');
  expect(markdown).toContain('世界');
  expect(markdown.indexOf('## 1 · User')).toBeLessThan(markdown.indexOf('## 2 · Thought'));
  expect(await runtime.journal()).toEqual(before);
  expect(await runtime.trace()).toBe(trace);
});

it('real v3 host streams bounded text/tool/form DTOs into the authoritative TypeScript session view', async () => {
  const runtime = await host(),
    client = runtime.client(),
    created = await create(client, runtime.root);
  const session = new WorkbenchSession(client, created.id);
  cleanups.push(() => session.stop());
  await session.start();
  const streamed = await turn(client, created.id, 'streamed-message');
  expect(
    streamed.page.entries.map((entry) =>
      'Inline' in entry.text ? entry.text.Inline.text : 'archived',
    ),
  ).toEqual(['streamed-message', 'reasoning', 'hello ', '世界']);
  await expect.poll(() => session.view.view?.revision).toBe(streamed.view.revision);
  expect(session.view.entries).toEqual(streamed.page.entries);
  expect(new Set(streamed.page.entries.slice(1).map((entry) => entry.message)).size).toBe(1);
  const output = await turn(client, created.id, 'tool-metadata');
  const turnId = output.page.entries.at(-1)!.turn;
  const tools = await client.call({ method: 'tools', session: created.id, turn: turnId });
  expect(tools.tools.length).toBeGreaterThan(0);
  await client.call({ method: 'prompt', session: created.id, prompt: 'elicitation-text' });
  await expect
    .poll(() => Object.keys(session.view.view?.pending_interactions || {}).length)
    .toBe(1);
  const interaction = Object.values(session.view.view!.pending_interactions)[0];
  expect(interaction.kind).toBe('Elicitation');
  await client.call({
    method: 'answer',
    session: created.id,
    answer: {
      interaction: interaction.id,
      response: { Form: { fields: { question_0: { Text: 'typed answer' } } } },
    },
  });
  await expect.poll(() => session.view.view?.status).toBe('Idle');
  expect(session.view.view?.pending_interactions).toEqual({});
  expect(session.view.error).toBeUndefined();
}, 20000);

it('real client reads exact immutable images after source removal/restart without journal or peer effects', async () => {
  const runtime = await host();
  let client = runtime.client();
  const created = await create(client, runtime.root);
  const output = await turn(client, created.id, 'image-output');
  const ref = output.page.entries.find((entry) => entry.image)!.image!;
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
    client = runtime.client(),
    created = await create(client, runtime.root);
  const source = await turn(client, created.id, 'streamed-message');
  const entry = source.page.entries.find((entry) => entry.role === 'User')!.id;
  const command = { method: 'fork' as const, session: created.id, request: { entry } };
  const fork = client.request(command);
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
  expect(await client.call({ method: 'history', session: created.id })).toEqual(source.page);
}, 20000);

it('real one-worker native fork returns typed independent origin and stable replay after source deletion/restart', async () => {
  const runtime = await host();
  let client = runtime.client();
  const created = await create(client, runtime.root),
    source = await turn(client, created.id, 'streamed-message');
  const entry = source.page.entries.find((entry) => entry.role === 'User')!.id;
  const command = { method: 'fork' as const, session: created.id, request: { entry } };
  const fork = client.request(command);
  expect(fork.operation).toBeDefined();
  const receipt = await fork.result;
  if (!('Forked' in receipt)) throw new Error('Forked summary absent');
  const branch = await client.call({ method: 'inspect', session: receipt.Forked.summary.id });
  expect(branch.id).not.toBe(created.id);
  expect(branch.provider_session).not.toBe(source.view.provider_session);
  expect(branch.origin?.session).toBe(created.id);
  expect(branch.origin?.entry).toBe(entry);
  expect(await client.call({ method: 'history', session: created.id })).toEqual(source.page);
  await client.call({ method: 'remove', session: created.id });
  await runtime.stop();
  await runtime.start();
  client = runtime.client();
  const trace = await runtime.trace();
  expect(await client.call(command, { operation: fork.operation })).toEqual(receipt);
  expect(await runtime.trace()).toBe(trace);
}, 20000);

it('operation lookup survives host restart without command replay, journal writes or provider startup', async () => {
  const runtime = await host();
  let client = runtime.client();
  const operation = operationId.parse('reload-create');
  const receipt = await client.call(
    { method: 'create', harness: 'Pi', cwd: runtime.root },
    { operation },
  );
  const before = await runtime.journal();
  expect(await client.call({ method: 'operation', operation })).toEqual({
    status: 'completed',
    receipt,
  });
  expect(
    await client.call({ method: 'operation', operation: operationId.parse('unknown') }),
  ).toEqual({ status: 'unknown' });
  expect(await runtime.journal()).toEqual(before);
  await expect(runtime.trace()).rejects.toMatchObject({ code: 'ENOENT' });
  await runtime.stop();
  await runtime.start();
  client = runtime.client();
  expect(await client.call({ method: 'operation', operation })).toEqual({
    status: 'completed',
    receipt,
  });
  expect(await runtime.journal()).toEqual(before);
  expect((await client.call({ method: 'list' })).sessions).toHaveLength(1);
  await expect(runtime.trace()).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);
