// Opt-in real Pi/ACP check: isolated settings, dummy API key, cache warming off, no model prompts.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildAdapter } from './build-adapter.mjs';

await buildAdapter();
const root = await mkdtemp(join(tmpdir(), 'pi-fast-smoke-'));
let agent;
try {
  const module = join(root, 'client.cjs');
  await build({
    entryPoints: ['test/support/acp-client.ts'],
    outfile: module,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { AgentProcess } = createRequire(import.meta.url)(module);
  await mkdir(join(root, 'pi-data'));
  await writeFile(
    join(root, 'pi-data/settings.json'),
    JSON.stringify({ cacheWarming: 'off', defaultProvider: 'openai', defaultModel: 'gpt-5.4' }),
  );
  const options = {
    command: process.execPath,
    args: [resolve('dist/pi-adapter.mjs')],
    cwd: root,
    env: {
      PI_ACP_PI_COMMAND: process.env.PI_ACP_PI_COMMAND || 'pi',
      PI_ACP_WORKBENCH_STATE_DIR: join(root, 'adapter-state'),
      PI_CODING_AGENT_DIR: join(root, 'pi-data'),
      OPENAI_API_KEY: 'isolated-smoke-no-model-requests',
    },
    update: () => {},
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    log: () => {},
    closed: () => {},
  };
  const fast = (response) =>
    response.configOptions?.find((c) => c.id === 'fast-mode')?.currentValue;
  agent = new AgentProcess(options);
  await agent.initialize();
  const session = await agent.createSession();
  assert.equal(fast(session), 'off');
  const change = (value) =>
    agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'fast-mode',
      value,
    });
  assert.equal(fast(await change('on')), 'on');
  await agent.stop();
  agent = new AgentProcess(options);
  await agent.initialize();
  assert.equal(fast(await agent.createSession(session.sessionId)), 'on');
  assert.equal(fast(await change('off')), 'off');
  await agent.stop();
  const registryPath = join(root, 'adapter-state/session-map.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  // Seed a private offline history fixture: no model call is needed to test native persistence.
  const stamp = new Date().toISOString();
  const fixture = [
    { type: 'session', version: 3, id: session.sessionId, timestamp: stamp, cwd: root },
    {
      type: 'model_change',
      id: 'model',
      parentId: null,
      timestamp: stamp,
      provider: 'openai',
      modelId: 'gpt-5.4',
    },
    {
      type: 'message',
      id: 'user',
      parentId: 'model',
      timestamp: stamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'offline persistence fixture' }],
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(
    registry.sessions[session.sessionId].sessionFile,
    fixture.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  registry.sessions[session.sessionId].workbenchFastMode = 'on';
  await writeFile(registryPath, JSON.stringify(registry));
  agent = new AgentProcess(options);
  await agent.initialize();
  assert.equal(fast(await agent.createSession(session.sessionId)), 'off');
  assert.equal(fast(await change('on')), 'on');
  await agent.stop();
  // The now-persisted native branch setting must beat an old index hint.
  registry.sessions[session.sessionId].workbenchFastMode = 'off';
  await writeFile(registryPath, JSON.stringify(registry));
  agent = new AgentProcess(options);
  await agent.initialize();
  assert.equal(fast(await agent.createSession(session.sessionId)), 'on');
  assert.equal(fast(await change('off')), 'off');
  console.log(
    'PASS real Pi ACP Fast mode: empty-session restart/load, native branch overrides stale index, On/Off; no model prompts',
  );
} finally {
  await agent?.stop();
  await rm(root, { recursive: true, force: true });
}
