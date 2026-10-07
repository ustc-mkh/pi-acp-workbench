import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lock } from 'proper-lockfile';
import { SessionService } from './session-service';
import type { ServiceConfig } from './session-protocol';
import { SessionServer } from './session-wire';
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'node dist/session-daemon.mjs --config /absolute/path/sessions.json [--data-dir /path]',
    );
    return;
  }
  const at = args.indexOf('--config');
  if (at < 0 || !args[at + 1]) throw new Error('需要 --config sessions.json');
  const raw = JSON.parse(await readFile(resolve(args[at + 1]), 'utf8'));
  const config: ServiceConfig = {
    ...raw,
    maxWorkers: raw.maxWorkers ?? 3,
    idleMs: raw.idleMs ?? 900000,
    command: raw.command || process.execPath,
    args: raw.command
      ? raw.args || []
      : [fileURLToPath(new URL('./pi-adapter.mjs', import.meta.url))],
    env: { ...raw.env, ELECTRON_RUN_AS_NODE: '1' },
  };
  if (
    !Number.isInteger(config.maxWorkers) ||
    config.maxWorkers < 1 ||
    config.maxWorkers > 8 ||
    !Number.isInteger(config.idleMs) ||
    config.idleMs < 1000 ||
    typeof config.command !== 'string' ||
    !Array.isArray(config.args) ||
    config.args.some((a) => typeof a !== 'string') ||
    Object.values(config.env || {}).some((v) => typeof v !== 'string')
  )
    throw new Error('工作进程参数无效');
  const dir = args.indexOf('--data-dir');
  if (dir >= 0 && !args[dir + 1]) throw new Error('--data-dir 缺少路径');
  const root = dir < 0 ? join(homedir(), '.pi', 'pi-acp-workbench') : resolve(args[dir + 1]);
  await mkdir(join(root, 'service'), { recursive: true, mode: 0o700 });
  let service: SessionService | undefined,
    server: SessionServer | undefined,
    compromised = false;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const release = await lock(join(root, 'service'), {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: 0,
    onCompromised: (error) => {
      compromised = true;
      console.error(error);
      stop();
    },
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    service = new SessionService(
      root,
      config,
      (event) => server?.broadcast(event),
      (error) => console.error(String(error)),
    );
    await service.initialize();
    server = new SessionServer(join(root, 'service', 'sessions.sock'), (m, p, id) =>
      service!.handle(m, p, id),
    );
    await server.listen();
    console.log(
      `Pi session service ready; maxWorkers=${config.maxWorkers}, idleMs=${config.idleMs}`,
    );
    await stopped;
  } finally {
    await server?.dispose();
    await service?.dispose();
    if (!compromised) await release();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
