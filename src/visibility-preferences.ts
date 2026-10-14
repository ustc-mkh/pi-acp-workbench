import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { writeAtomicJson } from './atomic-json';
import { isHarnessId, type HarnessId } from './harness';
import { validPriceModel } from './price-preferences';

export type VisibilityPreferences = Partial<Record<HarnessId, string[] | { hidden: string[] }>>;
const MAX_BYTES = 4 * 1024 * 1024;
function validList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every((id) => typeof id === 'string' && validPriceModel(id))
  );
}
function validPreferences(value: unknown): value is VisibilityPreferences {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([harness, entry]) =>
        isHarnessId(harness) &&
        (validList(entry) ||
          (!!entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            Object.keys(entry).length === 1 &&
            validList(entry.hidden))),
    )
  );
}
/** All windows merge targeted changes under a shared file lock. Legacy whitelist
 * entries remain intact until that harness has a known catalogue for migration. */
export class FileVisibilityPreferences {
  private observed = false;
  constructor(readonly file: string) {}
  read(legacy: VisibilityPreferences): VisibilityPreferences {
    let handle: number;
    try {
      handle = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.observed) throw new Error(`模型显示配置已丢失，拒绝重新创建：${this.file}`);
        return structuredClone(legacy);
      }
      throw error;
    }
    let body: Buffer;
    try {
      this.observed = true;
      if (!fstatSync(handle).isFile()) throw new Error(`模型显示配置不是普通文件：${this.file}`);
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= MAX_BYTES) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size));
        const n = readSync(handle, buffer, 0, buffer.length, null);
        if (!n) break;
        chunks.push(buffer.subarray(0, n));
        size += n;
      }
      body = Buffer.concat(chunks, size);
    } finally {
      closeSync(handle);
    }
    if (body.length > MAX_BYTES) throw new Error('模型显示配置过大，未覆盖原文件。');
    try {
      const data = JSON.parse(body.toString('utf8'));
      if (
        !data ||
        data.version !== 1 ||
        Object.keys(data).some((key) => !['version', 'preferences'].includes(key)) ||
        !validPreferences(data.preferences)
      )
        throw new Error('invalid preferences');
      return data.preferences;
    } catch (error) {
      throw new Error(`模型显示配置损坏，未覆盖原文件：${this.file}`, { cause: error });
    }
  }
  async set(
    harness: HarnessId,
    catalog: string[],
    affected: string[],
    checked: string[] | null,
    legacy: VisibilityPreferences,
  ) {
    if (
      !isHarnessId(harness) ||
      !validList(catalog) ||
      !validList(affected) ||
      (checked !== null && !validList(checked))
    )
      throw new Error('模型显示配置无效。');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const target = join(await realpath(dirname(this.file)), basename(this.file));
    const release = await lock(target, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 10, maxTimeout: 200 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    try {
      const preferences = this.read(legacy);
      // An explicit reset is retained in the file, not replaced by stale legacy data.
      if (checked === null) preferences[harness] = { hidden: [] };
      else {
        const saved = preferences[harness];
        const hidden = new Set(
          Array.isArray(saved) ? catalog.filter((id) => !saved.includes(id)) : saved?.hidden || [],
        );
        const visible = new Set(checked);
        for (const id of affected) {
          if (visible.has(id)) hidden.delete(id);
          else hidden.add(id);
        }
        preferences[harness] = { hidden: [...hidden] };
      }
      const data = { version: 1, preferences };
      if (!validPreferences(preferences) || Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES)
        throw new Error('模型显示配置过大或无效，未覆盖原文件。');
      await writeAtomicJson(this.file, data, true, () => {
        if (compromised) throw compromised;
      });
      this.observed = true;
    } finally {
      await release();
    }
  }
}
