import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lock } from 'proper-lockfile';
import { writeAtomicJson } from './atomic-json';
import { mergeUsage, type UsageRecord } from './telemetry';

export interface UsageStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
  patch?(
    key: 'usageTitles' | 'usageSessionNumbers',
    changes: Record<string, string | number | null>,
  ): PromiseLike<Record<string, string | number>>;
}

type UsageData = {
  version: 1;
  usageRecords: UsageRecord[];
  usageTitles: Record<string, string>;
  usageSessionNumbers: Record<string, number>;
};

/** Account-wide usage archive, independent of VS Code workspace/profile storage. */
export class FileUsageStorage implements UsageStorage {
  private data: UsageData;
  constructor(private readonly file: string) {
    this.data = this.read() ?? {
      version: 1,
      usageRecords: [],
      usageTitles: {},
      usageSessionNumbers: {},
    };
  }
  get<T>(key: string, fallback: T): T {
    return ((this.data as unknown as Record<string, unknown>)[key] as T | undefined) ?? fallback;
  }
  async update(key: string, value: unknown) {
    if (!(key in this.data)) throw new Error(`未知用量存储字段：${key}`);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await lock(this.file, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 10, maxTimeout: 200 },
    });
    try {
      const latest = this.read() ?? this.empty();
      let next: UsageData;
      if (key === 'usageRecords') {
        next = { ...latest, usageRecords: mergeUsage(latest.usageRecords, value as UsageRecord[]) };
      } else {
        // Merge per-session entries so a stale window cannot erase updates made by another.
        const field = latest[key as 'usageTitles' | 'usageSessionNumbers'];
        next = { ...latest, [key]: { ...field, ...(value as object) } } as UsageData;
      }
      await writeAtomicJson(this.file, next, true);
      this.data = next;
    } finally {
      await release();
    }
  }
  async patch(
    key: 'usageTitles' | 'usageSessionNumbers',
    changes: Record<string, string | number | null>,
  ) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await lock(this.file, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 30, minTimeout: 10, maxTimeout: 200 },
    });
    try {
      const latest = this.read() ?? this.empty();
      const map = { ...latest[key] } as Record<string, string | number>;
      for (const [id, value] of Object.entries(changes)) {
        if (value === null) delete map[id];
        else map[id] = value;
      }
      const next = { ...latest, [key]: map } as UsageData;
      await writeAtomicJson(this.file, next, true);
      this.data = next;
      return map;
    } finally {
      await release();
    }
  }
  private empty(): UsageData {
    return { version: 1, usageRecords: [], usageTitles: {}, usageSessionNumbers: {} };
  }
  private read(): UsageData | undefined {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`用量统计文件 JSON 损坏，拒绝覆盖：${this.file}`, { cause: error });
    }
    const data = value as Partial<UsageData> | null;
    if (
      !data ||
      data.version !== 1 ||
      !Array.isArray(data.usageRecords) ||
      !data.usageTitles ||
      typeof data.usageTitles !== 'object' ||
      Array.isArray(data.usageTitles) ||
      !Object.values(data.usageTitles).every((v) => typeof v === 'string') ||
      !data.usageSessionNumbers ||
      typeof data.usageSessionNumbers !== 'object' ||
      Array.isArray(data.usageSessionNumbers) ||
      !Object.values(data.usageSessionNumbers).every((v) => Number.isSafeInteger(v) && v > 0)
    )
      throw new Error(`用量统计文件版本或结构无效，拒绝覆盖：${this.file}`);
    return data as UsageData;
  }
}
