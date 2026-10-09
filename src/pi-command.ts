import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const windows = process.platform === 'win32';
const defaultCommand = windows ? 'pi.cmd' : 'pi';
const expandHome = (path: string) =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

async function executable(file: string) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function onPath(command: string, cwd = process.cwd()) {
  const extensions =
    windows && !/\.[^/\\]+$/.test(command)
      ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  for (const directory of (process.env.PATH || '').split(delimiter))
    for (const extension of extensions) {
      const file = resolve(cwd, directory, command + extension);
      if (await executable(file)) return file;
    }
}

/** Resolve each launch afresh: Pi upgrades and npm prefix changes must not leave a cached path. */
export async function resolvePiCommand(override?: string, cwd = process.cwd()): Promise<string> {
  const expanded = override?.trim() ? expandHome(override) : undefined;
  const configured = expanded && /[/\\]/.test(expanded) ? resolve(cwd, expanded) : expanded;
  if (configured) {
    if (isAbsolute(configured) || /[/\\]/.test(configured)) {
      try {
        await stat(configured);
        // Keep permission errors attached to an explicitly configured installation.
        return configured;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))
          return configured;
      }
    } else {
      const found = await onPath(configured, cwd);
      if (found) return found;
    }
  }
  const selected = (command: string) => {
    if (configured)
      process.stderr.write(
        `Pi executable override is missing (${configured}); using ${command}.\n`,
      );
    return command;
  };
  const fromPath = await onPath(defaultCommand, cwd);
  if (fromPath) return selected(fromPath);

  const nodeBin = dirname(process.execPath);
  const agentDir = expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  const candidates = [
    ...(process.env.PI_MANAGED_INSTALL_ROOT
      ? [join(dirname(expandHome(process.env.PI_MANAGED_INSTALL_ROOT)), 'bin', defaultCommand)]
      : []),
    join(agentDir, 'bin', defaultCommand),
    join(homedir(), '.pi', 'agent', 'bin', defaultCommand),
    join(nodeBin, defaultCommand),
    ...(prefix ? [join(expandHome(prefix), windows ? '' : 'bin', defaultCommand)] : []),
  ];
  for (const file of candidates) if (await executable(file)) return selected(file);

  // Ask the active npm installation for its prefix; do not assume ~/.local or /usr/local.
  if (!windows) {
    const npm =
      (await onPath('npm', cwd)) ||
      ((await executable(join(nodeBin, 'npm'))) && join(nodeBin, 'npm'));
    if (npm) {
      try {
        const { stdout } = await runFile(npm, ['prefix', '-g'], {
          cwd: homedir(),
          timeout: 3000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, PATH: nodeBin + delimiter + (process.env.PATH || '') },
        });
        const npmPrefix = stdout.trim();
        if (isAbsolute(npmPrefix)) {
          const file = join(npmPrefix, 'bin', defaultCommand);
          if (await executable(file)) return selected(file);
        }
      } catch {
        // Preserve the adapter's installation error if npm is absent or cannot answer.
      }
    }
  }
  return configured || defaultCommand;
}
