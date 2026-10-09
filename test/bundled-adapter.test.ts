import { it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { AgentProcess } from './support/acp-client';
import type { Inspection } from '../src/telemetry';
import type * as acp from '@agentclientprotocol/sdk';
beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {buildAdapter} from './scripts/build-adapter.mjs'; await buildAdapter();",
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
});
it.each(['user-bin', 'npm-prefix/bin'])(
  'starts Pi from PATH in %s without an executable override',
  async (installation) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-path-test-'));
    let agent: AgentProcess | undefined;
    vi.stubEnv('PI_ACP_PI_COMMAND', undefined);
    try {
      const bin = join(dir, installation);
      await mkdir(bin, { recursive: true });
      await symlink(resolve('test/mock-pi.mjs'), join(bin, 'pi'));
      agent = new AgentProcess({
        command: process.execPath,
        args: [resolve('dist/pi-adapter.mjs')],
        cwd: dir,
        env: {
          PATH: bin + delimiter + (process.env.PATH || ''),
          PI_ACP_WORKBENCH_STATE_DIR: join(dir, 'adapter-state'),
          PI_CODING_AGENT_DIR: join(dir, 'pi-data'),
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
it('exposes and toggles Fast mode through the bundled ACP config API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fast-adapter-'));
  let agent: AgentProcess | undefined;
  try {
    agent = new AgentProcess({
      command: process.execPath,
      args: [resolve('dist/pi-adapter.mjs')],
      cwd: dir,
      env: {
        PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
        PI_ACP_WORKBENCH_STATE_DIR: join(dir, 'adapter-state'),
        PI_CODING_AGENT_DIR: join(dir, 'pi-data'),
        PI_TEST_FAST_MODE: '1',
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
      args: [resolve('dist/pi-adapter.mjs')],
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
    expect(
      updates.some((update) => update.sessionUpdate === 'usage_update' && update.used === 1020),
    ).toBe(true);
    await live;
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
