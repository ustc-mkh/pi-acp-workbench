// Linux fixture diagnostics. Races with exiting children are recorded, not hidden.
import { readFile, readdir } from 'node:fs/promises';
export async function sampleProcessTree(rootPid) {
  const processes = [],
    exited = [],
    seen = new Set();
  async function visit(pid) {
    if (seen.has(pid)) return;
    seen.add(pid);
    try {
      const [status, children, fds] = await Promise.all([
        readFile(`/proc/${pid}/status`, 'utf8'),
        readdir(`/proc/${pid}/task`).then(async (tids) =>
          (
            await Promise.all(
              tids.map((tid) =>
                readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch((error) => {
                  if (['ENOENT', 'ESRCH'].includes(error.code)) return '';
                  throw error;
                }),
              ),
            )
          ).join(' '),
        ),
        readdir(`/proc/${pid}/fd`),
      ]);
      processes.push({
        pid,
        rss_kib: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
        threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1] || 0),
        fds: fds.length,
      });
      for (const child of children.trim().split(/\s+/).filter(Boolean)) await visit(Number(child));
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) exited.push(pid);
      else throw error;
    }
  }
  await visit(rootPid);
  return {
    processes,
    exited_during_sample: exited,
    count: processes.length,
    rss_kib: processes.reduce((n, p) => n + p.rss_kib, 0),
    threads: processes.reduce((n, p) => n + p.threads, 0),
    fds: processes.reduce((n, p) => n + p.fds, 0),
    scope:
      'Point-in-time live descendants; exited/reparented processes are not historical peak evidence.',
  };
}
