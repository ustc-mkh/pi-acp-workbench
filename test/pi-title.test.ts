import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePiTitle, parseTitleOutput, titleArgs } from '../src/pi-title';
import type { PiSession } from '../src/pi-rpc-types';
afterEach(() => vi.unstubAllEnvs());
const event = (text: string, stopReason = 'stop') =>
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason,
      content: [{ type: 'text', text }],
      usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0 },
    },
  });
it('parses JSONL on LF, not Unicode line separators, and retains title-call usage', () => {
  const value = parseTitleOutput(event('“模型\u2028设置改进”') + '\r\n', 's', 'p/m');
  expect(value.title).toBe('模型\u2028设置改进');
  expect(value.records[0]).toMatchObject({
    sessionId: 's',
    model: 'p/m',
    kind: 'session-title',
    input: 12,
    output: 8,
  });
  expect(parseTitleOutput(event('failed', 'error'), 's', 'p/m').title).toBe('');
  expect([...parseTitleOutput(event('修复'.repeat(40)), 's', 'p/m').title]).toHaveLength(32);
});
it('disables tools, persistence and all project resources', () => {
  const args = titleArgs('p', 'm');
  expect(args).toEqual(
    expect.arrayContaining([
      '--no-tools',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-context-files',
      '--no-session',
      '--thinking',
      'off',
    ]),
  );
  expect(args).not.toContain('--session');
});
it('uses an isolated bounded-input subprocess without touching the working conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'title-test-'));
  try {
    const command = join(root, 'fake-pi'),
      audit = join(root, 'audit');
    await writeFile(
      command,
      `#!${process.execPath}\nconst fs = require('node:fs'); let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => input += data); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(audit)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input })); console.log(${JSON.stringify(event('合并模型设置页面'))}); });`,
      { mode: 0o700 },
    );
    vi.stubEnv('PI_ACP_PI_COMMAND', command);
    const proc = {
      getState: vi.fn(async () => ({ model: { provider: 'p', id: 'm' } })),
      getAvailableModels: vi.fn(async () => ({
        models: [
          { provider: 'p', id: 'm' },
          { provider: 'p', id: 'cheap' },
        ],
      })),
      prompt: vi.fn(),
    };
    const session = { proc, cwd: root, sessionId: 's' } as unknown as PiSession;
    const result = await generatePiTitle(session, 'p/cheap', '输入😀'.repeat(600));
    expect(result.title).toBe('合并模型设置页面');
    const observed = JSON.parse(await readFile(audit, 'utf8'));
    expect([...observed.input]).toHaveLength(1000);
    expect(observed.cwd).not.toBe(root);
    expect(observed.args).toEqual(expect.arrayContaining(['--model', 'cheap']));
    expect(proc.prompt).not.toHaveBeenCalled();
    await expect(generatePiTitle(session, 'unknown/model', 'task')).rejects.toThrow('不在 Pi 目录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
