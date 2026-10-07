import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentProcess } from '../src/agent';
import { localSessionId } from '../src/harness';
it.each(['codex', 'claude'] as const)(
  '%s translates IDs for load, prompts, notifications, permissions, config and cancellation',
  async (harness) => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-harness-wire-')),
      file = join(dir, 'wire.jsonl');
    const updates: string[] = [],
      permissions: string[] = [];
    const agent = new AgentProcess({
      harness,
      command: process.execPath,
      args: [resolve('test/mock-agent.mjs')],
      cwd: process.cwd(),
      env: { PI_TEST_AUDIT: file },
      log: () => {},
      closed: () => {},
      update: (n) => updates.push(n.sessionId),
      permission: async (p) => {
        permissions.push(p.sessionId);
        return { outcome: { outcome: 'selected', optionId: 'yes' } };
      },
    });
    try {
      await agent.initialize();
      const session = await agent.createSession();
      const id = localSessionId(harness, 'test-session');
      expect(session.sessionId).toBe(id);
      await agent.createSession(id);
      await agent.prompt(id, [{ type: 'text', text: 'hello' }]);
      await agent.prompt(id, [{ type: 'text', text: 'permission' }]);
      await agent.request('session/set_config_option', {
        sessionId: id,
        configId: 'model',
        value: 'other',
      });
      const turn = agent.prompt(id, [{ type: 'text', text: 'wait' }]);
      await agent.cancel(id);
      expect((await turn).stopReason).toBe('cancelled');
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every((value) => value === id)).toBe(true);
      expect(permissions).toEqual([id]);
      const wire = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        wire.filter((r) => r.params?.sessionId).every((r) => r.params.sessionId === 'test-session'),
      ).toBe(true);
      expect(wire.find((r) => r.method === 'initialize').params.clientCapabilities).toEqual({});
      expect(wire.some((r) => r.method?.startsWith('_pi_workbench/'))).toBe(false);
    } finally {
      agent.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
