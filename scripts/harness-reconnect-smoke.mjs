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
  for (const harness of ['codex', 'claude']) {
    const prefix = harness.toUpperCase() + '_ACP_',
      cwd = join(root, harness);
    await mkdir(cwd);
    const command =
      process.env[prefix + 'COMMAND'] || (harness === 'codex' ? 'codex-acp' : 'claude-agent-acp');
    const args = JSON.parse(process.env[prefix + 'ARGS'] || '[]');
    let commands = [],
      id;
    const create = () =>
      new AgentProcess({
        harness,
        command,
        args,
        cwd,
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
      agent.dispose();
    }
    await delay(2000);
    commands = [];
    agent = create();
    try {
      await agent.initialize();
      const restored = await agent.createSession(id);
      await delay(500);
      assert(restored.sessionId.startsWith(`workbench:${harness}:`));
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
      agent.dispose();
    }
    await delay(2000);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
