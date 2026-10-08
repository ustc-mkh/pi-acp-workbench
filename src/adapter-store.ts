import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAtomicFileSync } from './atomic-json';
import { lockSync } from 'proper-lockfile';

/** Upstream's synchronous registry API needs a cross-process read/modify/write transaction. */
export function mutateAdapterStore(
  file: string,
  update: (data: { version: number; sessions: Record<string, unknown> }) => void,
) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let release: (() => void) | undefined;
  const until = Date.now() + 10000;
  while (!release) {
    try {
      release = lockSync(file, { realpath: false, stale: 30000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    let data: { version: number; sessions: Record<string, unknown> } = { version: 1, sessions: {} };
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
      if (
        data.version !== 1 ||
        !data.sessions ||
        typeof data.sessions !== 'object' ||
        Array.isArray(data.sessions)
      )
        throw new Error('Pi ACP 会话索引损坏，未覆盖原文件。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    update(data);
    writeAtomicFileSync(file, JSON.stringify(data) + '\n', true);
  } finally {
    release();
  }
}
