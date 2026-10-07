import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface OutboxRecord {
  id: string;
  sessionId: string;
  inputText?: string;
  text: string;
  status: string;
  updated: number;
}
export async function readOutbox(root: string): Promise<OutboxRecord[]> {
  const directory = join(root, 'telegram', 'events'),
    events: OutboxRecord[] = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const event = JSON.parse(await readFile(join(directory, name), 'utf8')) as OutboxRecord;
    if (createHash('sha256').update(event.id).digest('hex') + '.json' !== name)
      throw new Error('Outbox filename/id mismatch');
    events.push(event);
  }
  return events.sort((a, b) => a.updated - b.updated);
}

/** Independent fixture fingerprint writer, never a service executor. */
export function requestFingerprint(method: string, params: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ method, params })))
    .digest('hex');
}
export async function workerPids(pid: number): Promise<number[]> {
  const children = new Set<number>();
  for (const task of await readdir(`/proc/${pid}/task`)) {
    try {
      for (const value of (await readFile(`/proc/${pid}/task/${task}/children`, 'utf8'))
        .trim()
        .split(/\s+/))
        if (value) children.add(Number(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...children];
}
export async function processResources(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  return {
    rssMiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) / 1024,
    fdCount: (await readdir(`/proc/${pid}/fd`)).length,
    workers: await workerPids(pid),
  };
}
