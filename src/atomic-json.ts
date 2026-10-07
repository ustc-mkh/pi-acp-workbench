import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Atomic replacement. Durable writes also sync the file and its directory before returning.
 * The parent directory must already exist. Directory sync requires a POSIX filesystem.
 */
export async function writeAtomicJson(file: string, data: unknown, durable = false): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data), 'utf8');
      if (durable) await handle.sync();
    } finally {
      await handle.close();
    }
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
