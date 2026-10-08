import { it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentProcess } from '../src/agent';
import type { Inspection } from '../src/telemetry';
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
it('negotiates real bundled ACP extensions, reads native billing/context and reports model errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  let agent: AgentProcess | undefined;
  try {
    await mkdir(join(dir, '.pi'));
    await writeFile(join(dir, '.pi/settings.json'), '{"quietStartup":true}');
    const updates: any[] = [];
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
    expect(updates.some((update) => update.content?.text?.includes('手动压缩后的上下文'))).toBe(
      true,
    );
    await expect(
      agent.prompt(sessionId, [{ type: 'text', text: '/compact fail' }]),
    ).rejects.toThrow('compaction model unavailable');
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
    expect(await agent.prompt(sessionId, [{ type: 'text', text: 'recovered' }])).toMatchObject({
      stopReason: 'end_turn',
    });
  } finally {
    agent?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
