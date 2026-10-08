import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** Atomic replacement. Durable writes also sync the file and its directory before returning.
 * The parent directory must already exist. Directory sync requires a POSIX filesystem.
 */
export async function writeAtomicJson(
  file: string,
  data: unknown,
  durable = false,
  beforeRename?: () => void,
): Promise<void> {
  await writeAtomicFile(file, JSON.stringify(data), durable, beforeRename);
}

/** Atomic text replacement, also usable for JSONL session files. */
export async function writeAtomicFile(
  file: string,
  body: string,
  durable = false,
  beforeRename?: () => void,
): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
    beforeRename?.();
    await rename(temp, file);
    if (durable) {
      const directory = await open(dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/** Synchronous counterpart for the upstream adapter's synchronous registry API. */
export function writeAtomicFileSync(file: string, body: string, durable = false): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(handle, body, 'utf8');
      if (durable) fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, file);
    if (durable) {
      const directory = openSync(dirname(file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
