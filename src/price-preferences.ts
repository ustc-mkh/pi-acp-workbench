import { closeSync, openSync, readSync, fstatSync, constants } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { writeAtomicJson } from './atomic-json';
import { validPrice, priceOverrideVersion, type Price } from './telemetry';

export type PriceOverrides = Record<string, Price | null>;
export interface PricePreferences {
  read(legacy: PriceOverrides): PriceOverrides;
  set(
    model: string,
    value: Price | null,
    legacy: PriceOverrides,
    expectedVersion?: string,
  ): Promise<void>;
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
 * Old workspace preferences are never imported, including when the file is missing.
 */
export class FilePricePreferences implements PricePreferences {
  private observed = false;
  constructor(readonly file: string) {}

  read(_legacy: PriceOverrides = {}): PriceOverrides {
    let handle: number;
    try {
      handle = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.observed) throw new Error(`模型价格配置已丢失，拒绝重新创建：${this.file}`);
        return {};
      }
      throw error;
    }
    try {
      this.observed = true;
      if (!fstatSync(handle).isFile()) throw new Error(`模型价格配置不是普通文件：${this.file}`);
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

  async set(
    model: string,
    value: Price | null,
    _legacy: PriceOverrides = {},
    expectedVersion?: string,
  ) {
    if (!validPriceModel(model) || (value !== null && !validPrice(value)))
      throw new Error('模型价格配置无效。');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    // Windows opened through symlinked workspace/storage paths must share one lock.
    const lockFile = join(await realpath(dirname(this.file)), basename(this.file));
    const release = await lock(lockFile, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 10, maxTimeout: 200 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    try {
      const overrides = this.read();
      if (
        expectedVersion !== undefined &&
        priceOverrideVersion(model, overrides) !== expectedVersion
      )
        throw new Error('模型价格已在其他窗口更新，请重新加载窗口后确认，未覆盖已有价格。');
      overrides[model] = value;
      if (!validOverrides(overrides)) throw new Error('模型价格配置无效或模型数量过多。');
      const data = { version: 1, overrides };
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES)
        throw new Error('模型价格配置过大，未覆盖原文件。');
      await writeAtomicJson(this.file, data, true, () => {
        if (compromised) throw compromised;
      });
      this.observed = true;
    } finally {
      await release();
    }
  }
}
