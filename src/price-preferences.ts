import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lock } from 'proper-lockfile';
import { writeAtomicJson } from './atomic-json';
import { validPrice, type Price } from './telemetry';

export type PriceOverrides = Record<string, Price | null>;
export interface PricePreferences {
  read(legacy: PriceOverrides): PriceOverrides;
  set(model: string, value: Price | null, legacy: PriceOverrides): Promise<void>;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 10000;
export function validPriceModel(model: string) {
  return (
    !!model.trim() &&
    model.length <= 300 &&
    !['__proto__', 'constructor', 'prototype'].includes(model) &&
    !/[\x00-\x1f\x7f]/.test(model)
  );
}
function validOverrides(value: unknown): value is PriceOverrides {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length <= MAX_MODELS &&
    Object.entries(value).every(
      ([model, price]) => validPriceModel(model) && (price === null || validPrice(price)),
    )
  );
}

/** Independent of Memento's whole-extension cache. All writers lock, reread the
 * latest file, change one model, and durably replace it before releasing the lock.
 * The first transaction imports the legacy workspace preferences; later writes
 * never import an older window's cached data again.
 */
export class FilePricePreferences implements PricePreferences {
  constructor(readonly file: string) {}

  read(legacy: PriceOverrides): PriceOverrides {
    let handle: number;
    try {
      handle = openSync(this.file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...legacy };
      throw error;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= MAX_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size));
        const n = readSync(handle, chunk, 0, chunk.length, null);
        if (!n) break;
        chunks.push(chunk.subarray(0, n));
        size += n;
      }
      if (size > MAX_BYTES) throw new Error('模型价格配置过大，未覆盖原文件。');
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch (error) {
        throw new Error(`模型价格配置损坏，未覆盖原文件：${this.file}`, { cause: error });
      }
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        Object.keys(data).some((k) => !['version', 'overrides'].includes(k)) ||
        (data as { version?: unknown }).version !== 1 ||
        !validOverrides((data as { overrides?: unknown }).overrides)
      )
        throw new Error('模型价格配置损坏，未覆盖原文件。');
      return { ...(data as { overrides: PriceOverrides }).overrides };
    } finally {
      closeSync(handle);
    }
  }

  async set(model: string, value: Price | null, legacy: PriceOverrides) {
    if (!validPriceModel(model) || (value !== null && !validPrice(value)))
      throw new Error('模型价格配置无效。');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lock(this.file, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 10, maxTimeout: 200 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    try {
      const overrides = this.read(legacy);
      overrides[model] = value;
      if (!validOverrides(overrides)) throw new Error('模型价格配置无效或模型数量过多。');
      const data = { version: 1, overrides };
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES)
        throw new Error('模型价格配置过大，未覆盖原文件。');
      await writeAtomicJson(this.file, data, true, () => {
        if (compromised) throw compromised;
      });
    } finally {
      await release();
    }
  }
}
