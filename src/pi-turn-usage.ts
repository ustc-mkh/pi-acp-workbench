import { open, stat } from 'node:fs/promises';
/** Only bytes appended by this prompt, never imported native/fork history. */
export async function usageCursor(path?: string) {
  if (!path) return;
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile()) return { path, ino: info.ino, size: info.size };
}
export async function appendedUsage(cursor: Awaited<ReturnType<typeof usageCursor>>) {
  if (!cursor) return;
  const file = await open(cursor.path, 'r');
  try {
    const info = await file.stat();
    const bytes = info.size - cursor.size;
    if (info.ino !== cursor.ino || bytes <= 0 || bytes > 4 * 1024 * 1024) return;
    const buffer = Buffer.alloc(bytes);
    let position = 0;
    while (position < bytes) {
      const chunk = await file.read(buffer, position, bytes - position, cursor.size + position);
      if (!chunk.bytesRead) return;
      position += chunk.bytesRead;
    }
    let count = 0;
    const result = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const message = entry.message;
      if (message?.role !== 'assistant') continue;
      if (++count > 500 || !message.usage) return;
      const usage = message.usage;
      for (const [source, target] of [
        ['input', 'inputTokens'],
        ['output', 'outputTokens'],
        ['cacheRead', 'cachedReadTokens'],
        ['cacheWrite', 'cachedWriteTokens'],
      ] as const) {
        if (!Number.isSafeInteger(usage[source]) || usage[source] < 0) return;
        result[target] += usage[source];
        if (!Number.isSafeInteger(result[target])) return;
      }
    }
    return count ? result : undefined;
  } finally {
    await file.close();
  }
}
