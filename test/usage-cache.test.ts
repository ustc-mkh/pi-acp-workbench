import { expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enhancePiAgent } from '../src/pi-enhancements';
import type { UsageRecord } from '../src/telemetry';

it('paginates cached usage and invalidates it on append and truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-usage-cache-'));
  const sessionFile = join(dir, 'session.jsonl');
  const line = (id: number) =>
    JSON.stringify({
      id: String(id),
      type: 'message',
      timestamp: Date.now(),
      message: { usage: { input: 1, output: 2 } },
    }) + '\n';
  try {
    await writeFile(sessionFile, Array.from({ length: 501 }, (_, i) => line(i)).join(''));
    const session = {
      sessionId: 'one',
      proc: {
        request: async () => ({ success: true, data: { entries: [], leafId: null } }),
        getState: async () => ({ sessionFile, model: { provider: 'test', id: 'model' } }),
        getMessages: async () => ({ messages: [] }),
        getAvailableModels: async () => ({ models: [] }),
      },
    };
    class Base {
      sessions = new Map([['one', session]]);
    }
    const Agent = enhancePiAgent(Base, undefined),
      agent = new Agent();
    const inspect = (cursor?: number) =>
      agent.extMethod('_pi_workbench/inspect', { sessionId: 'one', cursor });
    expect((await inspect()).records).toHaveLength(500);
    expect((await inspect(500)).records).toHaveLength(1);
    const cache = agent as unknown as { usageCache?: { key: string; records: UsageRecord[] } };
    const cached = cache.usageCache;
    await inspect(500);
    expect(cache.usageCache).toBe(cached);
    await appendFile(sessionFile, line(501));
    expect((await inspect(500)).records).toHaveLength(2);
    await writeFile(sessionFile, line(999));
    expect((await inspect()).records.map((r) => r.id)).toEqual(['one:999']);
    await expect(
      agent.extMethod('_pi_workbench/inspect', { sessionId: 'missing' }),
    ).rejects.toThrow('Unknown session');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
