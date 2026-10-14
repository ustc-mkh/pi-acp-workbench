import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { writeAtomicJson } from './atomic-json';
import { isHarnessId, type HarnessId } from './harness';

export class FileClientSettings {
  private observed = false;
  constructor(readonly file: string) {}
  read(): { selectedHarness?: HarnessId } {
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.observed) return {};
      throw new Error(`客户端设置无法读取，未覆盖原文件：${this.file}`, { cause: error });
    }
    try {
      this.observed = true;
      if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
      const buffer = Buffer.alloc(4097);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > 4096) throw new Error('too large');
      const data = JSON.parse(buffer.subarray(0, size).toString('utf8'));
      if (
        !data ||
        Array.isArray(data) ||
        data.version !== 1 ||
        Object.keys(data).some((k) => !['version', 'selectedHarness'].includes(k)) ||
        (data.selectedHarness !== undefined && !isHarnessId(data.selectedHarness))
      )
        throw new Error('invalid settings');
      return data.selectedHarness === undefined ? {} : { selectedHarness: data.selectedHarness };
    } catch (error) {
      throw new Error(`客户端设置损坏，未覆盖原文件：${this.file}`, { cause: error });
    } finally {
      closeSync(fd);
    }
  }
  async setSelectedHarness(harness: HarnessId) {
    if (!isHarnessId(harness)) throw new Error('Agent 标识无效。');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const target = join(await realpath(dirname(this.file)), basename(this.file));
    let compromised: Error | undefined;
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
      const settings = this.read();
      await writeAtomicJson(
        this.file,
        { version: 1, ...settings, selectedHarness: harness },
        true,
        () => {
          if (compromised) throw compromised;
        },
      );
      this.observed = true;
    } finally {
      await release();
    }
  }
}
