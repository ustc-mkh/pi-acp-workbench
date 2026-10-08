import { readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function reportRetention(value = '5') {
  const keep = Number(value);
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new Error('TEST_KEEP_RUNS must be a positive integer');
  return keep;
}

export async function pruneTestReports(root, keep) {
  reportRetention(keep);
  const reports = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[\w-]+$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    let active = false;
    try {
      const pid = Number(await readFile(join(path, '.active'), 'utf8'));
      // A malformed marker is conservatively treated as an active run.
      if (!Number.isSafeInteger(pid) || pid < 1) active = true;
      else {
        try {
          process.kill(pid, 0);
          active = true;
        } catch (error) {
          if (error.code !== 'ESRCH') active = true;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      reports.push({ path, active, modified: (await stat(path)).mtimeMs });
    } catch (error) {
      // Another completed run may have pruned this directory concurrently.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  reports.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  const inactive = reports.filter((r) => !r.active);
  const slots = Math.max(0, keep - reports.filter((r) => r.active).length);
  for (const report of inactive.slice(slots))
    await rm(report.path, { recursive: true, force: true });
}
