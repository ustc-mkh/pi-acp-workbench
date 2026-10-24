// Real installed VS Code, isolated profile/workspace/root; no download or mock vscode API.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, cp, rm, readFile, symlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolveWorkbenchBinary } from './lib/workbench-binary.mjs';
import { WorkbenchWire } from '../test/helpers/workbench-wire.mjs';
export function extensionHostBlocker(platform, env) {
  if (platform !== 'linux') return 'This isolated Extension Host runner currently targets Linux';
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
    return 'No display available: run under an isolated xvfb-run display or explicitly provided graphical test environment';
}
export function extensionHostConfig(root, full = false) {
  return {
    workers: {
      pi: {
        command: process.execPath,
        args: [resolve('test/contract-agent.mjs')],
        env: full
          ? {
              WORKBENCH_CONTRACT_TYPED_SETTINGS: '1',
              WORKBENCH_CONTRACT_WORKSPACE_FILE: join(root, 'workspace/review.txt'),
              WORKBENCH_CONTRACT_WORKSPACE_DELETE: join(root, 'workspace/gone.txt'),
              WORKBENCH_CONTRACT_WORKSPACE_ADD: join(root, 'workspace/added.txt'),
              WORKBENCH_CONTRACT_TRACE: join(root, 'provider-trace.ndjson'),
            }
          : {},
      },
      codex: null,
      claude: null,
    },
    storage: { root: join(root, 'data') },
    sessions: { mailbox: 128, max_workers: 1 },
    limits: { pending_interactions: 32 },
  };
}
export async function run({ full = false, vsix, trust = false } = {}) {
  full ||= trust;
  assert(!vsix || full, 'Installed VSIX acceptance requires the native driver');
  const blocker = extensionHostBlocker(process.platform, process.env);
  if (blocker) {
    console.error(`BLOCKED real Extension Host: ${blocker}`);
    process.exitCode = 2;
    return;
  }
  const binary = resolveWorkbenchBinary(process.env.WORKBENCH_TEST_BINARY);
  const root = await mkdtemp(join(tmpdir(), 'workbench-extension-host-'));
  const evidence = resolve('.test-results', `extension-host-${randomUUID()}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const resultFile = join(root, 'extension-host-result.json');
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
    if (!child.pid) return;
    const signal = (value) => {
      try {
        process.kill(-child.pid, value);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    };
    signal('SIGTERM');
    // Reload may already have released the CLI while its private Electron
    // process group still owns the profile. Join that group before removal.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    signal('SIGKILL');
  }
  try {
    for (const name of ['workspace', 'data', 'home', 'profile/User', 'extensions', 'extension'])
      await mkdir(join(root, name), { recursive: true });
    const workspace = join(root, 'workspace'),
      socket = join(root, 'data/workbench.sock');
    if (full) {
      execFileSync('git', ['init', '-q', workspace]);
      await writeFile(join(workspace, '.gitignore'), '*\n!review.txt\n!gone.txt\n!added.txt\n');
      await writeFile(join(workspace, 'review.txt'), 'before\n');
      await writeFile(join(workspace, 'gone.txt'), 'deleted before\n');
    }
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify(extensionHostConfig(root, full)), { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'home/config'),
      XDG_DATA_HOME: join(root, 'home/data'),
      XDG_CACHE_HOME: join(root, 'home/cache'),
      WORKBENCH_EXTENSION_TEST_REPORT: resultFile,
      ...(trust ? { WORKBENCH_EXTENSION_TRUST_TEST: '1' } : {}),
      ...(full ? { WORKBENCH_EXTENSION_CDP_FILE: join(root, 'profile/DevToolsActivePort') } : {}),
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
        'window.dialogStyle': 'custom',
        'files.simpleDialog.enable': true,
        ...(trust
          ? {
              'security.workspace.trust.enabled': true,
              'security.workspace.trust.startupPrompt': 'never',
            }
          : {}),
      }),
    );
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    if (vsix) {
      const archive = resolve(vsix);
      const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
        .trim()
        .split('\n');
      assert(
        entries
          .filter((entry) => entry.startsWith('extension/'))
          .every((entry) => !entry.split('/').some((part) => part === '..' || part.includes('\\'))),
        'VSIX extension entries must remain inside the isolated root',
      );
      execFileSync('unzip', ['-q', archive, 'extension/*', '-d', root]);
      const installed = JSON.parse(await readFile(join(root, 'extension/package.json'), 'utf8'));
      assert.equal(installed.name, pkg.name);
      assert.equal(installed.publisher, pkg.publisher);
      assert.equal(installed.version, pkg.version);
      await rename(
        join(root, 'extension'),
        join(root, `extensions/${pkg.publisher}.${pkg.name}-${pkg.version}`),
      );
    } else {
      await writeFile(join(root, 'extension/package.json'), JSON.stringify(pkg));
      await cp('dist', join(root, 'extension/dist'), { recursive: true });
    }
    if (full) {
      // VS Code intentionally auto-answers dialogs in extensionTestsPath mode.
      // A temporary, isolated driver extension exercises the normal native
      // dialog path instead; it never patches the vscode API or product code.
      const driver = join(root, 'extensions/local-p6.ui-driver-0.0.0');
      await mkdir(driver, { recursive: true });
      await cp('test/extension-host', driver, { recursive: true });
      await cp('test/helpers/workbench-wire.mjs', join(driver, 'workbench-wire.mjs'));
      await symlink(resolve('node_modules'), join(driver, 'node_modules'), 'dir');
      await writeFile(
        join(driver, 'package.json'),
        JSON.stringify({
          name: 'ui-driver',
          publisher: 'local-p6',
          version: '0.0.0',
          engines: { vscode: '^1.96.0' },
          main: './driver.cjs',
          activationEvents: ['*'],
          capabilities: { untrustedWorkspaces: { supported: true } },
          ...(!trust ? { extensionDependencies: ['local-pi.pi-acp-workbench'] } : {}),
        }),
      );
      await writeFile(
        join(driver, 'driver.cjs'),
        `const vscode = require('vscode');
const fs = require('node:fs/promises');
exports.activate = () => { setTimeout(async () => {
  try { await require('./index.cjs').run(); }
  catch (error) { await fs.writeFile(process.env.HOME.replace(/\\/home$/, '') + '/native-ui-failure.json', JSON.stringify({ error: String(error.stack || error) })); }
  finally {
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath.startsWith(process.env.HOME.replace(/\\/home$/, '') + '/workspace/')) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    }
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}, 0); };
`,
      );
    }
    const code = spawn(
      process.env.WORKBENCH_VSCODE_EXECUTABLE || 'code',
      [
        '--new-window',
        '--wait',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        ...(!trust ? ['--disable-workspace-trust'] : []),
        ...(full ? ['--remote-debugging-port=0'] : []),
        '--user-data-dir',
        join(root, 'profile'),
        '--extensions-dir',
        join(root, 'extensions'),
        ...(!vsix ? ['--extensionDevelopmentPath=' + join(root, 'extension')] : []),
        ...(!full ? ['--extensionTestsPath=' + resolve('test/extension-host/index.cjs')] : []),
        workspace,
      ],
      { env, detached: true, stdio: 'inherit' },
    );
    children.push(code);
    await new Promise((res, rej) => {
      const budget = full ? 180000 : 90000;
      const timer = setTimeout(
        () =>
          rej(
            new Error(
              `Real Extension Host timed out (${budget / 1000}s, ${full ? 'native UI matrix' : 'basic activation'})`,
            ),
          ),
        budget,
      );
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
    if (full) {
      // `code --wait` can release its CLI during Reload before the replacement
      // Extension Host has written its receipt. Keep the private window alive
      // until the driver records a terminal result, bounded independently.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const terminal = await Promise.all([
          readFile(resultFile, 'utf8').then(
            () => true,
            () => false,
          ),
          readFile(join(root, 'native-ui-failure.json'), 'utf8').then(
            () => true,
            () => false,
          ),
        ]);
        if (terminal.some(Boolean)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // A zero CLI exit is not proof that --extensionTestsPath actually ran.
    const result = JSON.parse(
      await readFile(resultFile, 'utf8').catch(async (error) => {
        const failure = await readFile(join(root, 'native-ui-failure.json'), 'utf8').catch(
          () => undefined,
        );
        if (failure) throw new Error(`Native Extension Host UI failed: ${failure}`);
        throw error;
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.workspace, workspace);
    assert(result.session);
    if (full) assert(result.native_ui?.passed, 'native UI matrix report required');
    const sha256 = async (path) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    result.artifacts = {
      daemon_sha256: await sha256(binary),
      extension_mode: vsix ? 'installed VSIX' : 'development extension',
      ...(vsix ? { vsix_sha256: await sha256(resolve(vsix)) } : {}),
    };
    await writeFile(join(evidence, 'report.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(
      `PASS real Extension Host ${full ? 'native UI matrix' : 'basic activation/create/snapshot-provider smoke'}: ${evidence} (synthetic daemon peer; not online provider acceptance)`,
    );
  } catch (error) {
    await cp(join(root, 'profile/logs'), join(evidence, 'logs'), { recursive: true }).catch(
      () => {},
    );
    await cp(join(root, 'native-ui-failure.png'), join(evidence, 'failure.png')).catch(() => {});
    await cp(join(root, 'native-ui-failure.json'), join(evidence, 'failure.json')).catch(() => {});
    await writeFile(join(evidence, 'error.txt'), String(error.stack || error), { mode: 0o600 });
    throw error;
  } finally {
    wire?.close();
    for (const child of children.reverse()) await stop(child);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      full: { type: 'boolean', default: false },
      vsix: { type: 'string' },
      trust: { type: 'boolean', default: false },
    },
  });
  await run({ full: values.full, vsix: values.vsix, trust: values.trust });
}
