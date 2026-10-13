import { expect, it, vi } from 'vitest';
import {
  handlePiRunEvent,
  piRunBusy,
  piMessageId,
  settlePiRun,
  cancelPiRun,
  rejectPiPrompt,
} from '../src/pi-session-runs';
function fixture() {
  const session = {
    sessionId: 's',
    pendingTurn: null as null | {
      message?: string;
      resolve(reason: string): void;
      reject(error: unknown): void;
    },
    turnQueue: [] as { resolve(reason: string): void; reject(error: unknown): void }[],
    cancelRequested: false,
    modelError: undefined as string | undefined,
    inAgentLoop: false,
    proc: { getState: vi.fn(), request: vi.fn(async () => ({})), abort: vi.fn(async () => {}) },
    emit: vi.fn(),
    publishContextUsage: vi.fn(async () => {}),
    startTurn: vi.fn(),
  };
  const event = (type: string, data = {}) => handlePiRunEvent(session, { type, ...data });
  const lifecycle = () =>
    session.emit.mock.calls.map(([update]) => update._meta?.['pi-workbench-run']).filter(Boolean);
  return { session, event, lifecycle };
}
it('keeps retries busy until settled, displays custom notices and assigns message ids without partial snapshots', async () => {
  const { session, event, lifecycle } = fixture();
  event('agent_start');
  event('agent_end');
  expect(piRunBusy(session)).toBe(true);
  event('agent_start');
  expect(lifecycle()).toHaveLength(1);
  event('message_end', {
    message: { role: 'custom', display: true, content: 'background finished' },
  });
  expect(session.emit).toHaveBeenCalledWith(
    expect.objectContaining({
      content: { type: 'text', text: 'background finished' },
      _meta: { 'pi-workbench-notice': true },
    }),
  );
  event('message_start', { message: { role: 'assistant' } });
  const first = piMessageId(session);
  event('message_start', { message: { role: 'assistant' } });
  expect(piMessageId(session)).not.toBe(first);
  await settlePiRun(session, (e) => new Error(e));
  expect(lifecycle()).toMatchObject([
    { autonomous: true, running: true },
    { autonomous: true, running: false },
  ]);
  expect(piRunBusy(session)).toBe(false);
});
it('a wake during old settled metadata cannot consume a queued user or be cleared by old completion', async () => {
  const { session, event, lifecycle } = fixture();
  const old = { resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = old;
  event('agent_start');
  let release!: () => void;
  session.publishContextUsage.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const ending = settlePiRun(session, (e) => new Error(e));
  const next = { resolve: vi.fn(), reject: vi.fn() };
  session.turnQueue.push(next);
  event('agent_start');
  release();
  await ending;
  expect(old.resolve).toHaveBeenCalledOnce();
  expect(next.resolve).not.toHaveBeenCalled();
  expect(session.startTurn).not.toHaveBeenCalled();
  expect(piRunBusy(session)).toBe(true);
  expect(lifecycle()[2]).toMatchObject({ autonomous: true, running: true });
  await settlePiRun(session, (e) => new Error(e));
  expect(session.startTurn).toHaveBeenCalledWith(next);
});
it('detached settled I/O cannot resolve, reject or clear a newer prompt', async () => {
  const { session, event } = fixture();
  const old = { resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = old;
  event('agent_start');
  session.modelError = 'old failure';
  let release!: () => void;
  session.publishContextUsage.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const ending = settlePiRun(session, (e) => new Error(e));
  const next = { resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = next;
  event('agent_start');
  release();
  await ending;
  expect(old.reject).toHaveBeenCalledOnce();
  expect(session.pendingTurn).toBe(next);
  expect(next.resolve).not.toHaveBeenCalled();
  expect(next.reject).not.toHaveBeenCalled();
});
it('rejects a reserved input when a custom starter wins the last-mile race', async () => {
  const { session, event, lifecycle } = fixture();
  const user = { message: 'user input', resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = user;
  event('agent_start');
  event('message_start', { message: { role: 'custom' } });
  expect(session.pendingTurn).toBeNull();
  expect(user.reject).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('发送失败') }),
  );
  expect(lifecycle().at(-1)).toMatchObject({ autonomous: true, running: true });
  await settlePiRun(session, (e) => new Error(e));
  expect(user.resolve).not.toHaveBeenCalled();
  expect(user.reject).toHaveBeenCalledOnce();
});
it('clears plugin native queues without aborting a wake that starts during cancellation I/O', async () => {
  const { session, event } = fixture();
  event('agent_start');
  let release!: () => void;
  session.proc.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = () => r({});
      }),
  );
  const cancellation = cancelPiRun(session);
  await settlePiRun(session, (e) => new Error(e));
  event('agent_start');
  release();
  await cancellation;
  expect(session.proc.request).toHaveBeenCalledWith({ type: 'clear_queue' });
  expect(session.proc.abort).not.toHaveBeenCalled();
});
it('RPC busy rejection preserves the autonomous run before its custom starter arrives', async () => {
  const { session, event, lifecycle } = fixture();
  const user = { resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = user;
  event('agent_start');
  rejectPiPrompt(session, user, new Error('Agent is streaming'), (message) => new Error(message));
  expect(session.pendingTurn).toBeNull();
  expect(piRunBusy(session)).toBe(true);
  expect(lifecycle().at(-1)).toMatchObject({ autonomous: true, running: true });
  event('message_start', { message: { role: 'custom' } });
  await settlePiRun(session, (message) => new Error(message));
  expect(user.reject).toHaveBeenCalledOnce();
  expect(user.resolve).not.toHaveBeenCalled();
});
it('does not reject steering notices in a real user run or let an old rejection affect a new slot', async () => {
  const { session, event, lifecycle } = fixture();
  const old = { resolve: vi.fn(), reject: vi.fn() };
  const current = { resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = current;
  event('agent_start');
  event('message_start', { message: { role: 'user' } });
  event('message_start', { message: { role: 'custom' } });
  rejectPiPrompt(session, old, new Error('Agent is streaming'), (message) => new Error(message));
  expect(lifecycle().at(-1)).toMatchObject({ autonomous: false, running: true });
  expect(current.reject).not.toHaveBeenCalled();
  await settlePiRun(session, (message) => new Error(message));
  expect(current.resolve).toHaveBeenCalledWith('end_turn');
});
it('does not resolve or reject an already refused input again when the autonomous run settles', async () => {
  const { session, event } = fixture();
  const user = { message: 'refused', resolve: vi.fn(), reject: vi.fn() };
  session.pendingTurn = user;
  event('agent_start');
  event('message_start', { message: { role: 'custom' } });
  session.modelError = 'background failed';
  await settlePiRun(session, (e) => new Error(e));
  expect(session.pendingTurn).toBeNull();
  expect(user.resolve).not.toHaveBeenCalled();
  expect(user.reject).toHaveBeenCalledOnce();
});
