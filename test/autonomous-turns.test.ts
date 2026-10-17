import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startRustService } from './rust-service';
import type { ServiceState } from '../src/session-protocol';
import { readOutbox } from './rust-utils';
import { transcriptBlocks } from '../webview/transcript';
let adapterDir: string;
const cleanup: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  adapterDir = await mkdtemp(join(tmpdir(), 'pi-autonomous-build-'));
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import {buildAdapter} from './scripts/build-adapter.mjs'; await buildAdapter({outdir:${JSON.stringify(adapterDir)}});`,
  ]);
});
afterAll(async () => {
  await rm(adapterDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(env: Record<string, string> = {}, warmup = true) {
  const root = await mkdtemp(join(tmpdir(), 'pi-autonomous-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const control = join(root, 'control'),
    audit = join(root, 'audit.jsonl');
  await writeFile(audit, '');
  const service = await startRustService(root, {
    command: process.execPath,
    args: [join(adapterDir, 'pi-adapter.mjs')],
    maxWorkers: 2,
    idleMs: 900000,
    env: {
      PI_ACP_PI_COMMAND: resolve('test/mock-pi.mjs'),
      PI_ACP_WORKBENCH_STATE_DIR: join(root, 'registry'),
      PI_CODING_AGENT_DIR: join(root, 'pi-data'),
      PI_TEST_WAKE_CONTROL: control,
      PI_TEST_PREFLIGHT_AUDIT: audit,
      ...env,
    },
  });
  cleanup.push(() => service.stop());
  await service.call('setTitleModel', { model: 'off' });
  const session = await service.call('create', { cwd: root, harness: 'pi' });
  const state = () => service.call<ServiceState>('state', { sessionId: session.id });
  const prompt = (text: string) =>
    service.call('prompt', { sessionId: session.id, prompt: [{ type: 'text', text }] });
  if (warmup) await prompt('warm-up');
  const signal = (suffix: string) => writeFile(control + '.' + suffix, 'go');
  const events = async () =>
    (await readFile(audit, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  const busy = () =>
    vi.waitFor(async () => {
      expect((await state()).busy).toBe(true);
      expect(
        (await state()).snapshot.entries.some((e) => 'text' in e && e.text === '自主唤醒回复'),
      ).toBe(true);
    });
  return { root, service, session, state, prompt, signal, events, busy, control };
}
it('retains restore-time autonomous output and rejects user input without waiting to deliver it', async () => {
  const f = await fixture({ PI_TEST_WAKE_ON_RESTORE: '1' }, false);
  await expect(f.prompt('user during restore')).rejects.toThrow('发送失败');
  await f.busy();
  expect((await f.events()).some((e) => e.message === 'user during restore')).toBe(false);
  await f.signal('finish');
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  expect((await f.events()).some((e) => e.message === 'user during restore')).toBe(false);
  expect((await f.state()).snapshot.entries).toContainEqual(
    expect.objectContaining({
      role: 'user',
      text: 'user during restore',
      sendError: expect.stringContaining('发送失败'),
    }),
  );
});
it('publishes autonomous busy state, displays the callback, persists final output and publishes completion', async () => {
  const f = await fixture();
  const before = (await f.state()).snapshot.entries;
  const previousAnswer = before.filter((entry) => entry.role === 'assistant').at(-1)!;
  expect(previousAnswer.turnId).toEqual(expect.any(String));
  await f.signal('wake');
  await f.busy();
  const during = (await f.state()).snapshot.entries;
  const newAnswer = during.find(
    (entry) => entry.role === 'assistant' && entry.text === '自主唤醒回复',
  )!;
  expect(newAnswer.turnId).toEqual(expect.any(String));
  expect(newAnswer.turnId).not.toBe(previousAnswer.turnId);
  expect(transcriptBlocks(during, true)).toContainEqual({ kind: 'message', entry: previousAnswer });
  expect((await f.state()).snapshot.entries).toContainEqual(
    expect.objectContaining({ role: 'notice', text: '后台任务已完成' }),
  );
  expect((await f.state()).snapshot.entries).toContainEqual(
    expect.objectContaining({ role: 'thought', text: '后台分析' }),
  );
  expect((await f.state()).snapshot.entries).toContainEqual(
    expect.objectContaining({
      role: 'tool',
      tool: expect.objectContaining({ status: 'completed', content: expect.any(Array) }),
    }),
  );
  await f.signal('finish');
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  const folder = join(f.root, 'history', 'conversations');
  const saved = await Promise.all(
    (await readdir(folder)).map((file) => readFile(join(folder, file), 'utf8')),
  );
  expect(saved.some((text) => text.includes('自主唤醒回复'))).toBe(true);
  const persisted = saved
    .map((text) => JSON.parse(text))
    .find((snapshot) => snapshot.id === f.session.id);
  expect(transcriptBlocks(persisted.entries)).toContainEqual({
    kind: 'message',
    entry: previousAnswer,
  });
  expect(persisted.entries.find((entry: { id: string }) => entry.id === newAnswer.id).turnId).toBe(
    newAnswer.turnId,
  );
  expect(await readOutbox(f.root)).toContainEqual(
    expect.objectContaining({
      id: expect.stringMatching(/^autonomous:/),
      status: 'completed',
      text: expect.stringContaining('自主唤醒回复'),
    }),
  );
});
it('rejects input during an autonomous run and never sends it after cancellation or completion', async () => {
  const f = await fixture();
  await f.signal('wake');
  await f.busy();
  await expect(f.prompt('refused user')).rejects.toThrow('发送失败');
  await f.signal('continue');
  await vi.waitFor(async () =>
    expect(
      (await f.state()).snapshot.entries.filter(
        (entry) => entry.role === 'assistant' && entry.text.includes('自主唤醒回复'),
      ),
    ).toEqual([expect.objectContaining({ text: '自主唤醒回复，继续输出' })]),
  );
  expect((await f.state()).busy).toBe(true);
  expect((await f.events()).some((e) => e.message === 'refused user')).toBe(false);
  expect(await f.service.call('cancel', { sessionId: f.session.id })).toBe(true);
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  expect((await f.prompt('following user')).stopReason).toBe('end_turn');
  expect((await f.events()).filter((e) => e.message === 'following user')).toHaveLength(1);
  expect((await f.events()).some((e) => e.message === 'refused user')).toBe(false);
});
it('replays a rejected request as failure after idle without delivering it or duplicating its entry', async () => {
  const f = await fixture();
  await f.signal('wake');
  await f.busy();
  const params = { sessionId: f.session.id, prompt: [{ type: 'text', text: 'do not replay' }] };
  await expect(f.service.call('prompt', params, 'refused-once')).rejects.toThrow('发送失败');
  await f.signal('finish');
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  await expect(f.service.call('prompt', params, 'refused-once')).rejects.toThrow('发送失败');
  expect(
    (await f.state()).snapshot.entries.filter((entry) => entry.id === 'input:refused-once'),
  ).toHaveLength(1);
  expect((await f.events()).some((event) => event.message === 'do not replay')).toBe(false);
});
it('a wake during old settled metadata refuses a new input even if the wake finishes before admission', async () => {
  const f = await fixture();
  await f.signal('stats-hold');
  const old = f.prompt('old user');
  await vi.waitFor(async () =>
    expect((await f.events()).some((e) => e.message === 'old user')).toBe(true),
  );
  await f.signal('wake');
  await f.busy();
  const next = f.prompt('refused new user').catch((error: Error) => error);
  await new Promise((r) => setTimeout(r, 50));
  await f.signal('finish');
  await rm(f.control + '.stats-hold');
  expect((await old).stopReason).toBe('end_turn');
  expect(await next).toMatchObject({ message: expect.stringContaining('发送失败') });
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  expect((await f.events()).some((e) => e.message === 'refused new user')).toBe(false);
});
it('allows autonomous permission dialogs and keeps late completions scoped across successive wakes', async () => {
  const f = await fixture();
  await f.signal('permission');
  await f.signal('wake');
  await f.busy();
  await vi.waitFor(async () => expect((await f.state()).permissions).toHaveLength(1));
  const permission = (await f.state()).permissions[0];
  expect((await f.state()).permissions).toHaveLength(1);
  await expect(f.prompt('user while background permission is pending')).rejects.toThrow('发送失败');
  expect((await f.state()).permissions[0].id).toBe(permission.id);
  const inspection = await Promise.race([
    f.service.call<{ prices: Record<string, { input: number }> }>('request', {
      sessionId: f.session.id,
      method: '_pi_workbench/inspect',
      params: { force: false },
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('inspection waited for autonomous completion')),
        1500,
      );
      timer.unref();
    }),
  ]);
  expect(inspection.prices['anthropic/claude-sonnet-4-6'].input).toBe(3);
  expect((await f.state()).busy).toBe(true);
  expect((await f.state()).snapshot.configs).toContainEqual(
    expect.objectContaining({ id: 'model', currentValue: 'anthropic/claude-sonnet-4-6' }),
  );
  expect((await f.state()).permissions[0].id).toBe(permission.id);
  expect(
    await f.service.call('permission', {
      sessionId: f.session.id,
      permissionId: permission.id,
      optionId: 'yes',
    }),
  ).toBe(true);
  await f.signal('finish');
  await f.signal('wake');
  await vi.waitFor(async () => {
    const state = await f.state();
    expect(state.busy).toBe(true);
    expect(
      state.snapshot.entries.filter((e) => 'text' in e && e.text === '自主唤醒回复'),
    ).toHaveLength(2);
  });
  await new Promise((r) => setTimeout(r, 100));
  expect((await f.state()).busy).toBe(true);
  await f.signal('finish');
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  expect(
    (await readOutbox(f.root)).filter(
      (e) => e.id.startsWith('autonomous:') && e.status === 'completed',
    ),
  ).toHaveLength(2);
});
it('a last-mile refused input is never run after cancelling the wake', async () => {
  const f = await fixture();
  await f.signal('race');
  await expect(f.prompt('last-mile cancelled input')).rejects.toThrow('发送失败');
  await f.busy();
  expect(await f.service.call('cancel', { sessionId: f.session.id })).toBe(true);
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  expect((await f.events()).some((e) => e.type === 'clear_queue')).toBe(true);
  expect((await f.prompt('next admitted input')).stopReason).toBe('end_turn');
  expect((await f.events()).filter((e) => e.message === 'next admitted input')).toHaveLength(1);
  expect(
    (await f.events()).some(
      (e) => e.type === 'message_start' && e.message === 'last-mile cancelled input',
    ),
  ).toBe(false);
});
it('the last-mile wake/input race refuses instead of using native followUp and keeps output/publication live', async () => {
  const f = await fixture();
  await f.signal('race');
  await expect(f.prompt('last-mile user')).rejects.toThrow('发送失败');
  await f.busy();
  expect((await f.state()).snapshot.entries).toContainEqual(
    expect.objectContaining({
      role: 'user',
      text: 'last-mile user',
      sendError: expect.stringContaining('发送失败'),
    }),
  );
  expect(
    (await f.events()).some((e) => e.type === 'prompt' && e.streamingBehavior === 'followUp'),
  ).toBe(false);
  await f.signal('finish');
  await vi.waitFor(async () => expect((await f.state()).busy).toBe(false));
  const entries = (await f.state()).snapshot.entries;
  expect(entries.filter((e) => 'text' in e && e.text === 'last-mile user')).toHaveLength(1);
  const publications = await readOutbox(f.root);
  const background = publications.find((e) => e.id.startsWith('autonomous:'))!;
  expect(background.text).toContain('自主唤醒回复');
  expect(background.status).toBe('completed');
  expect(background.text).not.toContain('last-mile user');
});
