import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { resolvePiCommand } from '../src/pi-command';

let root: string;
let bin: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-command-'));
  bin = join(root, 'path');
  await mkdir(bin);
  vi.stubEnv('HOME', root);
  vi.stubEnv('PATH', bin + delimiter + dirname(process.execPath));
  for (const key of [
    'PI_CODING_AGENT_DIR',
    'PI_MANAGED_INSTALL_ROOT',
    'npm_config_prefix',
    'NPM_CONFIG_PREFIX',
  ])
    vi.stubEnv(key, undefined);
  // Keep every lookup isolated from the developer's global npm prefix.
  await writeFile(
    join(bin, 'npm'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(join(root, 'npm-global'))});\n`,
    { mode: 0o755 },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function install(file: string) {
  await mkdir(dirname(file), { recursive: true });
  await symlink(resolve('test/mock-pi.mjs'), file);
  return file;
}
it('honors an existing explicit executable ahead of PATH and resolves relative paths in the worker cwd', async () => {
  await install(join(bin, 'pi'));
  const override = await install(join(root, 'custom', 'pi'));
  expect(await resolvePiCommand(override)).toBe(override);
  expect(await resolvePiCommand('./pi', dirname(override))).toBe(override);
});
it.each(['', '.', 'relative-bin'])('ignores untrusted relative PATH entry %j', async (entry) => {
  const cwd = join(root, 'repo');
  await install(join(cwd, 'pi'));
  await install(join(cwd, 'relative-bin', 'pi'));
  const trusted = await install(join(bin, 'pi'));
  vi.stubEnv('PATH', entry + delimiter + bin + delimiter + entry);
  expect(await resolvePiCommand(undefined, cwd)).toBe(trusted);
});
it('prefers the managed installation root to the agent data directory', async () => {
  const managed = await install(join(root, 'managed', 'bin', 'pi'));
  await install(join(root, 'data', 'bin', 'pi'));
  vi.stubEnv('PI_MANAGED_INSTALL_ROOT', join(root, 'managed', 'install'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'data'));
  expect(await resolvePiCommand()).toBe(managed);
});
it('recovers a missing override from PATH and reports the selected executable on stderr', async () => {
  const found = await install(join(bin, 'pi'));
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stale = join(root, 'old-user', 'bin', 'pi');
  expect(await resolvePiCommand(stale)).toBe(found);
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`using ${found}`));
});
it('preserves permission errors on an existing explicitly configured installation', async () => {
  await install(join(bin, 'pi'));
  const file = join(root, 'not-executable');
  await writeFile(file, 'pi');
  await chmod(file, 0o644);
  expect(await resolvePiCommand(file)).toBe(file);
});
it('uses PATH ahead of the managed installation and finds the latter with a restricted service PATH', async () => {
  const managed = await install(join(root, '.pi', 'agent', 'bin', 'pi'));
  const path = await install(join(bin, 'pi'));
  expect(await resolvePiCommand()).toBe(path);
  await rm(path);
  expect(await resolvePiCommand()).toBe(managed);
});
it.each(['PI_CODING_AGENT_DIR', 'PI_MANAGED_INSTALL_ROOT'])(
  'discovers a custom managed installation from %s',
  async (key) => {
    const agentDir = join(root, 'custom-agent');
    const found = await install(join(agentDir, 'bin', 'pi'));
    vi.stubEnv(key, key === 'PI_CODING_AGENT_DIR' ? agentDir : join(agentDir, 'install'));
    expect(await resolvePiCommand()).toBe(found);
  },
);
it('queries npm for a custom global prefix that is absent from PATH', async () => {
  const found = await install(join(root, 'npm-global', 'bin', 'pi'));
  expect(await resolvePiCommand()).toBe(found);
});
it('finds the default managed launcher even when a different Pi data directory is configured', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'separate-profile'));
  const found = await install(join(root, '.pi', 'agent', 'bin', 'pi'));
  expect(await resolvePiCommand()).toBe(found);
});
it('finds Pi beside the active Node executable without assuming a global prefix', async () => {
  const originalNode = process.execPath;
  const found = await install(join(root, 'node-prefix', 'bin', 'pi'));
  try {
    process.execPath = join(dirname(found), 'node');
    expect(await resolvePiCommand()).toBe(found);
  } finally {
    process.execPath = originalNode;
  }
});
it('uses configured npm prefixes and rechecks the executable after an upgrade', async () => {
  const prefix = join(root, 'prefix');
  vi.stubEnv('npm_config_prefix', prefix);
  const found = await install(join(prefix, 'bin', 'pi'));
  expect(await resolvePiCommand()).toBe(found);
  await rm(found);
  const moved = await install(join(bin, 'pi'));
  expect(await resolvePiCommand()).toBe(moved);
});
it('fails closed rather than returning a bare command when only untrusted Pi launchers exist', async () => {
  const cwd = join(root, 'untrusted-repo');
  await install(join(cwd, 'pi'));
  await install(join(cwd, 'relative-bin', 'pi'));
  vi.stubEnv('PATH', ['', '.', 'relative-bin', bin].join(delimiter));
  await expect(resolvePiCommand(undefined, cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(resolvePiCommand('pi', cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  const stale = join(root, 'missing', 'pi');
  expect(await resolvePiCommand(stale, cwd)).toBe(stale);
});
