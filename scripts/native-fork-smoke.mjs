// Opt-in real Pi RPC test. Synthetic local history only; NO model prompt or compaction call.
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'pi-native-fork-')),
  children = [];
try {
  const agentModule = join(root, 'agent.cjs');
  await build({
    entryPoints: ['src/agent.ts'],
    outfile: agentModule,
    platform: 'node',
    format: 'cjs',
    bundle: true,
  });
  const { AgentProcess } = createRequire(import.meta.url)(agentModule);
  const module = join(root, 'native.cjs');
  await build({
    entryPoints: ['src/native-branch.ts'],
    outfile: module,
    platform: 'node',
    format: 'cjs',
    bundle: true,
  });
  const { nativePrefixHash, nativeForkPoints } = createRequire(import.meta.url)(module);
  const cwd = join(root, 'project'),
    dir = join(root, 'sessions');
  await mkdir(cwd);
  await mkdir(dir);
  const now = new Date().toISOString(),
    sessionId = randomUUID(),
    source = join(dir, 'source.jsonl'),
    entries = [];
  const add = (id, type, data) =>
    entries.push({ id, parentId: entries.at(-1)?.id || null, type, timestamp: now, ...data });
  add('model', 'model_change', {
    provider: process.env.PI_PROVIDER || 'openai-codex',
    modelId: process.env.PI_MODEL || 'gpt-5.4',
  });
  add('thinking', 'thinking_level_change', { thinkingLevel: 'high' });
  add('system', 'message', {
    message: { role: 'system', content: 'original system', timestamp: 1 },
  });
  add('u1', 'message', {
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'first question' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        },
      ],
      timestamp: 2,
    },
  });
  const assistant = (text, timestamp) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: process.env.PI_PROVIDER || 'openai-codex',
    model: process.env.PI_MODEL || 'gpt-5.4',
    api: 'openai-codex-responses',
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  add('a1', 'message', { message: assistant('first answer', 3) });
  add('u2', 'message', { message: { role: 'user', content: 'second question', timestamp: 4 } });
  add('a2', 'message', { message: assistant('second answer', 5) });
  add('compact', 'compaction', {
    summary: 'native summary preserved verbatim',
    firstKeptEntryId: 'u2',
    tokensBefore: 50000,
    systemMessage: { role: 'system', content: 'original system', timestamp: 1 },
  });
  add('u3', 'message', { message: { role: 'user', content: 'latest question', timestamp: 6 } });
  add('a3', 'message', { message: assistant('latest answer', 7) });
  const original =
    [{ type: 'session', version: 3, id: sessionId, timestamp: now, cwd }, ...entries]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  await writeFile(source, original);
  for (const entryId of ['u1', 'a1', 'a3']) {
    const child = spawn(
      process.env.PI_ACP_PI_COMMAND || 'pi',
      [
        '--mode',
        'rpc',
        '--no-themes',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--extension',
        resolve('dist/pi-native-fork.mjs'),
        '--session-dir',
        dir,
        '--session',
        source,
      ],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    children.push(child);
    const pending = new Map();
    let buffer = '',
      serial = 0;
    child.stdout.setEncoding('utf8').on('data', (text) => {
      buffer += text;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === 'response') pending.get(e.id)?.(e);
        } catch {}
      }
    });
    child.stderr.resume();
    const rpc = (params) =>
      new Promise((resolve, reject) => {
        const id = String(++serial),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('RPC timeout'));
          }, 30000);
        pending.set(id, (res) => {
          clearTimeout(timer);
          pending.delete(id);
          res.success ? resolve(res.data) : reject(new Error(res.error));
        });
        child.stdin.write(JSON.stringify({ ...params, id }) + '\n');
      });
    try {
      const state = await rpc({ type: 'get_state' });
      assert.equal(state.sessionId, sessionId);
      const point = nativeForkPoints(entries).find((p) => p.entryId === entryId);
      assert(point?.safe);
      await rpc({
        type: 'prompt',
        message: '/workbench-native-fork ' + JSON.stringify({ entryId, hash: point.hash }),
      });
      const fork = await rpc({ type: 'get_state' });
      assert.notEqual(fork.sessionId, sessionId);
      assert.equal(fork.thinkingLevel, 'high');
      const copied = await rpc({ type: 'get_entries' });
      assert.equal(nativePrefixHash(copied.entries), point.hash, JSON.stringify(copied.entries));
      await rpc({
        type: 'prompt',
        message:
          '/workbench-native-seal ' +
          JSON.stringify({ sourceSessionId: sessionId, hash: point.hash }),
      });
      const messages = (await rpc({ type: 'get_messages' })).messages;
      assert.equal(
        messages.some((m) => m.role === 'compactionSummary'),
        entryId === 'a3',
      );
      assert.equal(await readFile(source, 'utf8'), original, 'Source history was modified');
      console.log(
        JSON.stringify({
          entryId,
          nativePrefixIdentical: true,
          compactionPreserved: entryId === 'a3',
          sourceUnchanged: true,
          modelPrompts: 0,
        }),
      );
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  }
  const store = join(root, 'store');
  await mkdir(store);
  await writeFile(
    join(store, 'session-map.json'),
    JSON.stringify({
      version: 1,
      sessions: { [sessionId]: { sessionId, cwd, sessionFile: source } },
    }),
  );
  const options = {
    command: process.execPath,
    args: [resolve('dist/pi-adapter.mjs')],
    cwd,
    env: { PI_ACP_WORKBENCH_STATE_DIR: store },
    log: () => {},
    closed: () => {},
    update: () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };
  const agent = new AgentProcess(options),
    candidate = new AgentProcess(options);
  try {
    await agent.initialize();
    await agent.createSession(sessionId);
    const inspection = await agent.request('_pi_workbench/inspect', { sessionId });
    const point = inspection.forkPoints.find((p) => p.entryId === 'a3');
    assert(point?.safe);
    const fork = await agent.request('_pi_workbench/fork', {
      sessionId,
      entryId: point.entryId,
      hash: point.hash,
    });
    await candidate.initialize();
    await candidate.createSession(fork.sessionId);
    const forked = await candidate.request('_pi_workbench/inspect', { sessionId: fork.sessionId });
    assert.equal(forked.records.length, 0, 'Inherited usage was counted again');
    assert(forked.context.includes('native summary preserved verbatim'));
    const registered = JSON.parse(await readFile(join(store, 'session-map.json'), 'utf8')).sessions[
      fork.sessionId
    ];
    const header = JSON.parse((await readFile(registered.sessionFile, 'utf8')).split('\n')[0]);
    assert.equal(header.parentSession, source);
    assert.equal(await readFile(source, 'utf8'), original);
    console.log(
      JSON.stringify({
        bundledAdapterFork: true,
        loadOnNewConnection: true,
        inheritedBillingExcluded: true,
        sourceUnchanged: true,
      }),
    );
  } finally {
    agent.dispose();
    candidate.dispose();
    await new Promise((r) => setTimeout(r, 1800));
  }
} finally {
  for (const child of children) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await rm(root, { recursive: true, force: true });
}
