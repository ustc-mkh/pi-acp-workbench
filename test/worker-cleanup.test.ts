import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRustService } from './rust-service';

it.skipIf(process.platform !== 'linux')(
  'awaits cleanup after forced cancellation during replay before exiting the daemon',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-replay-cleanup-'));
    const script = join(root, 'worker.cjs');
    let workerPid: number | undefined;
    let service: Awaited<ReturnType<typeof startRustService>> | undefined;
    try {
      const marker = join(root, 'spawn-marker'),
        pidFile = join(root, 'stubborn.pid');
      await writeFile(
        script,
        `
const fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'first');
  import(${JSON.stringify(resolve('test/contract-agent.mjs'))});
} else {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
`,
      );
      service = await startRustService(root, {
        command: process.execPath,
        args: [script],
        env: {},
        maxWorkers: 2,
        idleMs: 900000,
      });
      const session = await service.call<{ id: string }>('create', { cwd: root, harness: 'pi' });
      const pending = service
        .call(
          'prompt',
          {
            sessionId: session.id,
            prompt: [{ type: 'text', text: 'must not start' }],
          },
          'cleanup-prompt',
        )
        .catch((e) => String(e));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          workerPid = Number(await readFile(pidFile, 'utf8'));
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(workerPid).toBeGreaterThan(0);
      expect(await service.call('cancel', { sessionId: session.id })).toBe(true);
      await pending;
      await service.stop();
      // stop() must not rely on a task in the now-exited daemon to deliver the
      // final signal. The unreaped worker leader would still have a /proc entry.
      await expect(readFile(`/proc/${workerPid}/stat`, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (workerPid) {
        // Do not signal a reused PID if cleanup succeeded but a later assertion failed.
        const command = await readFile(`/proc/${workerPid}/cmdline`, 'utf8').catch(() => '');
        if (command.includes(script)) {
          try {
            process.kill(-workerPid, 'SIGKILL');
          } catch {}
        }
      }
      await service?.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
