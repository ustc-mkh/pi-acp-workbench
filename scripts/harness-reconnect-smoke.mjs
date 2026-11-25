// Opt-in integration smoke: uses existing credentials, creates empty native sessions,
// and sends NO session/prompt. Adapters may keep native session metadata afterwards.
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'pi-acp-reconnect-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const bundle = join(root, 'agent.cjs');
  await build({
    entryPoints: ['test/support/acp-client.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  });
  const { AgentProcess } = createRequire(import.meta.url)(bundle);
  const profiles = {
    codex: { command: 'codex-acp', args: [] },
    claude: { command: 'claude-agent-acp', args: [] },
    antigravity: { command: 'agy', args: ['acp'] },
  };
  const requested = process.argv.slice(2);
  for (const harness of requested.length ? requested : ['codex', 'claude']) {
    assert(Object.hasOwn(profiles, harness), 'Unknown ACP harness');
    const prefix = harness.toUpperCase() + '_ACP_',
      cwd = join(root, harness);
    await mkdir(cwd);
    const command = process.env[prefix + 'COMMAND'] || profiles[harness].command;
    const args = process.env[prefix + 'ARGS']
      ? JSON.parse(process.env[prefix + 'ARGS'])
      : profiles[harness].args;
    let commands = [],
      id;
    const create = () =>
      new AgentProcess({
        harness,
        command,
        args,
        cwd,
        // Explicit manual live-provider command, never part of fixture gates.
        env: { ...process.env },
        requestTimeoutMs: 60000,
        update: (n) => {
          if (n.update.sessionUpdate === 'available_commands_update')
            commands = n.update.availableCommands;
        },
        log: () => {},
        closed: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
    let agent = create();
    try {
      await agent.initialize();
      id = (await agent.createSession()).sessionId;
      await delay(500);
      assert(commands.length > 0, `${harness}: no commands announced`);
    } finally {
      await agent.stop();
    }
    commands = [];
    agent = create();
    try {
      await agent.initialize();
      const restored = await agent.createSession(id);
      await delay(500);
      assert.equal(restored.sessionId, id, `${harness}: native identity changed`);
      assert(commands.length > 0, `${harness}: no commands after reconnect`);
      console.log(
        JSON.stringify({
          harness,
          reconnected: true,
          recreatedEmpty: restored.sessionId !== id,
          commands: commands.length,
          promptsSent: 0,
        }),
      );
    } finally {
      await agent.stop();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
