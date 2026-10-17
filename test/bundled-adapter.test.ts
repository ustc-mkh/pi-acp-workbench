import { it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter, dirname } from 'node:path';
import { AgentProcess } from './support/acp-client';
import { startRustService } from './rust-service';
import type { Inspection } from '../src/telemetry';
import type * as acp from '@agentclientprotocol/sdk';
// Build into a private directory: tests must not rewrite dist/ while packaging may read it.
let adapterDir = '';
const adapter = () => join(adapterDir, 'pi-adapter.mjs');
beforeAll(async () => {
  adapterDir = await mkdtemp(join(tmpdir(), 'pi-adapter-build-'));
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {buildAdapter} from './scripts/build-adapter.mjs'; await buildAdapter({ outdir: ${JSON.stringify(adapterDir)} });`,
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});
afterAll(async () => {
  if (adapterDir) await rm(adapterDir, { recursive: true, force: true });
});
it.each(['user-bin', 'npm-prefix/bin', 'stale-override', 'managed-install'])(
  'discovers and starts Pi in %s',
  async (installation) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-path-test-'));
    let agent: AgentProcess | undefined;
    vi.stubEnv('PI_ACP_PI_COMMAND', undefined);
    try {
      const managed = installation === 'managed-install';
      const bin = managed ? join(dir, 'pi-data', 'bin') : join(dir, installation);
      await mkdir(bin, { recursive: true });
      await symlink(resolve('test/mock-pi.mjs'), join(bin, 'pi'));
      agent = new AgentProcess({
        command: process.execPath,
        args: [adapter()],
        cwd: dir,
        env: {
          PATH: (managed ? dirname(process.execPath) : bin) + delimiter + dirname(process.execPath),
          PI_ACP_PI_COMMAND:
            installation === 'stale-override' ? join(dir, 'old-home', 'bin', 'pi') : '',
          PI_ACP_WORKBENCH_STATE_DIR: join(dir, 'adapter-state'),
          PI_CODING_AGENT_DIR: join(dir, 'pi-data'),
          PI_MANAGED_INSTALL_ROOT: '',
          PI_TEST_AUDIT: join(dir, 'audit.jsonl'),
        },
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        closed: () => {},
        log: () => {},
      });
      await agent.initialize();
      const session = await agent.createSession();
      expect(session.sessionId).toBeTruthy();
    } finally {
      await agent?.stop();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
it('cancels preflight before sending a model prompt, without cancelling the following turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-preflight-cancel-'));
  const flag = join(root, 'hold'),
    audit = join(root, 'rpc.jsonl');
  let agent: AgentProcess | undefined;
  try {
    await writeFile(audit, '');
    agent = new AgentProcess({
      command: process.execPath,
      args: [adapter()],
      cwd: root,
      env: {
        PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
        PI_ACP_WORKBENCH_STATE_DIR: join(root, 'registry'),
        PI_CODING_AGENT_DIR: join(root, 'pi-data'),
        PI_TEST_PREFLIGHT_FLAG: flag,
        PI_TEST_PREFLIGHT_AUDIT: audit,
      },
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      closed: () => {},
      log: () => {},
      requestTimeoutMs: 5000,
    });
    await agent.initialize();
    const session = await agent.createSession();
    await writeFile(flag, 'hold preflight');
    const running = agent.prompt(session.sessionId, [{ type: 'text', text: 'must-not-reach-Pi' }]);
    const events = async () =>
      (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { held?: string; type?: string; message?: string });
    await vi.waitFor(async () =>
      expect((await events()).some((event) => event.held === 'get_state')).toBe(true),
    );
    await agent.cancel(session.sessionId);
    expect((await running).stopReason).toBe('cancelled');
    expect(
      (await events()).some(
        (event) => event.type === 'prompt' && event.message === 'must-not-reach-Pi',
      ),
    ).toBe(false);
    expect(
      (await agent.prompt(session.sessionId, [{ type: 'text', text: 'next-turn' }])).stopReason,
    ).toBe('end_turn');
    expect(
      (await events()).filter((event) => event.type === 'prompt' && event.message === 'next-turn'),
    ).toHaveLength(1);
  } finally {
    await agent?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('honors preflight cancellation through the real daemon and bundled adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-daemon-preflight-'));
  const flag = join(root, 'hold'),
    audit = join(root, 'rpc.jsonl');
  let service: Awaited<ReturnType<typeof startRustService>> | undefined;
  try {
    await writeFile(audit, '');
    service = await startRustService(root, {
      command: process.execPath,
      args: [adapter()],
      maxWorkers: 2,
      idleMs: 900000,
      env: {
        PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
        PI_ACP_WORKBENCH_STATE_DIR: join(root, 'registry'),
        PI_CODING_AGENT_DIR: join(root, 'pi-data'),
        PI_TEST_PREFLIGHT_FLAG: flag,
        PI_TEST_PREFLIGHT_AUDIT: audit,
      },
    });
    await service.call('setTitleModel', { model: 'off' });
    const session = await service.call('create', { cwd: root, harness: 'pi' });
    await service.call('prompt', {
      sessionId: session.id,
      prompt: [{ type: 'text', text: 'warm-up' }],
    });
    await writeFile(flag, 'hold preflight');
    const running = service.call('prompt', {
      sessionId: session.id,
      prompt: [{ type: 'text', text: 'must-not-reach-Pi' }],
    });
    const events = async () =>
      (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { held?: string; type?: string; message?: string });
    await vi.waitFor(async () =>
      expect((await events()).some((event) => event.held === 'get_state')).toBe(true),
    );
    expect(await service.call('cancel', { sessionId: session.id })).toBe(true);
    expect((await running).stopReason).toBe('cancelled');
    expect(
      (await events()).some(
        (event) => event.type === 'prompt' && event.message === 'must-not-reach-Pi',
      ),
    ).toBe(false);
    expect(
      (
        await service.call('prompt', {
          sessionId: session.id,
          prompt: [{ type: 'text', text: 'next-turn' }],
        })
      ).stopReason,
    ).toBe('end_turn');
    expect(
      (await events()).filter((event) => event.type === 'prompt' && event.message === 'next-turn'),
    ).toHaveLength(1);
  } finally {
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it('uses dynamic discovery for terminal login when an old explicit path is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-login-path-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'pi'), '#!/usr/bin/env node\nconsole.log("pi-login-discovered");\n', {
      mode: 0o755,
    });
    const result = execFileSync(process.execPath, [adapter(), '--terminal-login'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + delimiter + dirname(process.execPath),
        PI_ACP_PI_COMMAND: join(dir, 'missing', 'pi'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result).toContain('pi-login-discovered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('exposes and toggles Fast mode through the bundled ACP config API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fast-adapter-'));
  let agent: AgentProcess | undefined;
  try {
    agent = new AgentProcess({
      command: process.execPath,
      args: [adapter()],
      cwd: dir,
      env: {
        PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
        PI_ACP_WORKBENCH_STATE_DIR: join(dir, 'adapter-state'),
        PI_CODING_AGENT_DIR: join(dir, 'pi-data'),
        PI_TEST_FAST_MODE: '1',
        PI_TEST_MODEL_RESETS_THINKING: '1',
      },
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      closed: () => {},
      log: () => {},
    });
    await agent.initialize();
    const session = await agent.createSession();
    expect(session.configOptions?.find((c) => c.id === 'fast-mode')?.currentValue).toBe('off');
    for (const value of ['on', 'off']) {
      const response = await agent.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'fast-mode',
        value,
      });
      expect(response.configOptions.find((c) => c.id === 'fast-mode')?.currentValue).toBe(value);
      const thinking = session.configOptions?.find((c) => c.category === 'thought_level');
      const model = session.configOptions?.find((c) => c.category === 'model');
      expect(thinking).toBeTruthy();
      expect(model).toBeTruthy();
      await agent.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: thinking!.id,
        value: 'high',
      });
      for (let i = 0; i < 3; i++) {
        const changed = await agent.request<{ configOptions: acp.SessionConfigOption[] }>(
          'session/set_config_option',
          {
            sessionId: session.sessionId,
            configId: model!.id,
            value: model!.currentValue,
          },
        );
        expect(changed.configOptions.find((c) => c.id === thinking!.id)?.currentValue).toBe('high');
        expect(changed.configOptions.find((c) => c.id === 'fast-mode')?.currentValue).toBe(value);
      }
    }
  } finally {
    await agent?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('negotiates real bundled ACP extensions, reads native billing/context and reports model errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  let agent: AgentProcess | undefined;
  try {
    await mkdir(join(dir, '.pi'));
    await writeFile(join(dir, '.pi/settings.json'), '{"quietStartup":true}');
    const updates: acp.SessionNotification['update'][] = [];
    agent = new AgentProcess({
      command: process.execPath,
      args: [adapter()],
      cwd: dir,
      env: {
        PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
        PI_ACP_WORKBENCH_STATE_DIR: join(dir, 'adapter-state'),
        PI_CODING_AGENT_DIR: join(dir, 'pi-data'),
        PI_TEST_AUDIT: join(dir, 'audit.jsonl'),
      },
      update: (notification) => updates.push(notification.update),
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      closed: () => {},
      log: () => {},
      requestTimeoutMs: 5000,
    });
    const info = await agent.initialize();
    expect(info.agentCapabilities?._meta?.['pi-workbench']).toMatchObject({ version: 1 });
    const { sessionId } = await agent.createSession();
    expect(await agent.prompt(sessionId, [{ type: 'text', text: 'test' }])).toMatchObject({
      stopReason: 'end_turn',
    });
    updates.length = 0;
    let completed = false;
    const live = agent
      .prompt(sessionId, [{ type: 'text', text: 'LONG_CONTEXT' }])
      .then((result) => {
        completed = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(completed).toBe(false);
    // Occupancy is a completion snapshot, not a streaming polling result.
    expect(updates.some((update) => update.sessionUpdate === 'usage_update')).toBe(false);
    await live;
    expect(
      updates.some((update) => update.sessionUpdate === 'usage_update' && update.used === 1020),
    ).toBe(true);
    updates.length = 0;
    expect(
      await agent.prompt(sessionId, [{ type: 'text', text: '/compact keep decisions' }]),
    ).toMatchObject({ stopReason: 'end_turn' });
    expect(
      updates.some(
        (update) =>
          (update.sessionUpdate === 'agent_message_chunk' ||
            update.sessionUpdate === 'agent_thought_chunk' ||
            update.sessionUpdate === 'user_message_chunk') &&
          update.content.type === 'text' &&
          update.content.text.includes('手动压缩后的上下文'),
      ),
    ).toBe(false);
    expect(updates).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '上下文压缩成功。' },
    });
    expect(updates).toContainEqual({
      sessionUpdate: 'session_info_update',
      _meta: { 'pi-workbench-context': { used: null, size: 200000 } },
    });
    updates.length = 0;
    await expect(
      agent.prompt(sessionId, [{ type: 'text', text: '/compact fail' }]),
    ).rejects.toThrow('compaction model unavailable');
    expect(updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(false);
    const inspect = () =>
      agent!.connection.agent.request<Inspection>('_pi_workbench/inspect', { sessionId });
    const data = await inspect();
    expect(data.records).toHaveLength(4);
    expect(data.records.map((r) => r.kind)).toEqual([
      'inference',
      'compaction',
      'inference',
      'compaction',
    ]);
    expect(data.records[0]).toMatchObject({
      cacheRead: 800,
      input: 100,
      cacheWrite: 100,
      output: 20,
    });
    expect(data.context).toContain('压缩后的历史摘要');
    expect(data.contextWindow).toBe(200000);
    expect(data.prices?.['anthropic/claude-sonnet-4-6']).toMatchObject({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      source: 'Pi 模型配置',
    });
    expect((await inspect()).records.map((r) => r.id)).toEqual(data.records.map((r) => r.id));
    await expect(agent.prompt(sessionId, [{ type: 'text', text: 'MODEL_ERROR' }])).rejects.toThrow(
      '模型服务返回网页错误',
    );
    updates.length = 0;
    expect(await agent.prompt(sessionId, [{ type: 'text', text: 'recovered' }])).toMatchObject({
      stopReason: 'end_turn',
    });
    expect(updates).toContainEqual({ sessionUpdate: 'usage_update', used: 1020, size: 200000 });
  } finally {
    agent?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
