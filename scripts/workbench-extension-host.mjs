// Real installed VS Code, isolated profile/workspace/root; no download or mock vscode API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, cp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';
export function extensionHostBlocker(platform, env) {
  if (platform !== 'linux') return 'This isolated Extension Host runner currently targets Linux';
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
    return 'No display available: run under an isolated xvfb-run display or explicitly provided graphical test environment';
}
export function extensionHostConfig(root) {
  return {
    workers: {
      pi: { command: process.execPath, args: [resolve('test/contract-agent.mjs')], env: {} },
      codex: null,
      claude: null,
    },
    storage: { root: join(root, 'data') },
    sessions: { mailbox: 128, max_workers: 1 },
    limits: { pending_interactions: 32 },
  };
}
export async function run() {
  const blocker = extensionHostBlocker(process.platform, process.env);
  if (blocker) {
    console.error(`BLOCKED real Extension Host: ${blocker}`);
    process.exitCode = 2;
    return;
  }
  const binary = resolveWorkbenchBinary(process.env.WORKBENCH_TEST_BINARY);
  const root = await mkdtemp(join(tmpdir(), 'workbench-extension-host-'));
  const children = [];
  let wire,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    process.exitCode = 1;
    for (const child of children) void stop(child);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  async function stop(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((r) => child.once('close', r));
    const signal = (value) => {
      try {
        process.kill(-child.pid, value);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 5000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (const name of ['workspace', 'data', 'home', 'profile/User', 'extensions', 'extension'])
      await mkdir(join(root, name), { recursive: true });
    const workspace = join(root, 'workspace'),
      socket = join(root, 'data/workbench.sock');
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify(extensionHostConfig(root)), { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'home/config'),
      XDG_DATA_HOME: join(root, 'home/data'),
      XDG_CACHE_HOME: join(root, 'home/cache'),
    };
    const daemon = spawn(binary, ['--config', config], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(daemon);
    let daemonLog = '';
    for (const stream of [daemon.stdout, daemon.stderr])
      stream.on('data', (c) => {
        daemonLog = (daemonLog + c.toString()).slice(-8192);
      });
    daemon.on('error', () => {});
    for (let i = 0; i < 100; i++) {
      if (interrupted) throw new Error('Extension Host run interrupted');
      try {
        wire = await WorkbenchWire.open(socket);
        break;
      } catch {
        if (daemon.exitCode !== null) throw new Error(`Daemon startup failed: ${daemonLog}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert(wire, 'Daemon socket did not become ready');
    wire.close();
    wire = undefined;
    await writeFile(
      join(root, 'profile/User/settings.json'),
      JSON.stringify({
        'piAcp.workbenchSocket': socket,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'workbench.startupEditor': 'none',
      }),
    );
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    await writeFile(join(root, 'extension/package.json'), JSON.stringify(pkg));
    await cp('dist', join(root, 'extension/dist'), { recursive: true });
    const code = spawn(
      process.env.WORKBENCH_VSCODE_EXECUTABLE || 'code',
      [
        '--new-window',
        '--wait',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--user-data-dir',
        join(root, 'profile'),
        '--extensions-dir',
        join(root, 'extensions'),
        '--extensionDevelopmentPath=' + join(root, 'extension'),
        '--extensionTestsPath=' + resolve('test/extension-host/index.cjs'),
        workspace,
      ],
      { env, detached: true, stdio: 'inherit' },
    );
    children.push(code);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Real Extension Host timed out (90s)')), 90000);
      code.once('error', (e) => {
        clearTimeout(timer);
        rej(e);
      });
      code.once('close', (status) => {
        clearTimeout(timer);
        status === 0 ? res() : rej(new Error(`Real Extension Host exited ${status}`));
      });
    });
    assert(!interrupted, 'Extension Host run interrupted');
    console.log(
      'PASS real Extension Host basic activation/create/snapshot-provider smoke (synthetic daemon peer; not online provider or modal/diff matrix)',
    );
  } finally {
    wire?.close();
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await run();
