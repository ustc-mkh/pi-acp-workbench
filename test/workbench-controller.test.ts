import { afterEach, expect, it } from 'vitest';
import { WorkbenchController } from '../src/workbench-controller';
import { uiStateMessage, type WorkbenchUiMessage } from '../src/workbench-ui';
import { entryId, imageRef, operationId, sessionId } from '../src/workbench-protocol';
import { emptySnapshot, workbenchPeer } from './helpers/workbench-peer';
const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
async function setup() {
  const peer = await workbenchPeer();
  peers.push(peer);
  const messages: WorkbenchUiMessage[] = [],
    authorization: string[] = [];
  let trusted = true;
  const controller = new WorkbenchController(peer.client(), {
    post: (message) => messages.push(message),
    trusted: () => trusted,
    workspace: () => '/workspace',
    authorize: async (cwd) => {
      authorization.push(cwd);
      if (cwd !== '/workspace') throw new Error('outside workspace');
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  const ready = controller.receive({ type: 'ready' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.reply(peer.requests[0], [{ SessionsListed: [emptySnapshot(5)] }]);
  await ready;
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.reply(peer.requests[2], [{ SessionLoaded: emptySnapshot(5) }]);
  await selecting;
  return {
    peer,
    controller,
    messages,
    authorization,
    setTrusted: (value: boolean) => (trusted = value),
  };
}
it('selection is cold, typed state reaches the webview, and only user mutation explicitly loads a provider', async () => {
  const { peer, controller, messages, authorization } = await setup();
  expect(peer.requests.map((r) => r.command.method)).toEqual(['list', 'subscribe', 'inspect']);
  expect(authorization).toEqual([]);
  const action = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'prompt', session: 'session', prompt: 'hello' },
  });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[3].command.method).toBe('load');
  peer.reply(peer.requests[3], [{ SessionLoaded: emptySnapshot(5) }]);
  await expect.poll(() => peer.requests.length).toBe(5);
  expect(peer.requests[4].command.method).toBe('prompt');
  expect(peer.requests[4].operation).toBeDefined();
  peer.reply(peer.requests[4]);
  await expect.poll(() => peer.requests.length).toBe(6);
  peer.reply(peer.requests[5], [{ SessionsListed: [emptySnapshot(6)] }]);
  await expect.poll(() => peer.requests.length).toBe(7);
  peer.reply(peer.requests[6], [{ SessionLoaded: emptySnapshot(6) }]);
  await action;
  expect(authorization).toEqual(['/workspace']);
  await expect.poll(() => messages.filter((m) => m.type === 'state').length).toBeGreaterThan(0);
  for (const message of messages)
    if (message.type === 'state') expect(() => uiStateMessage.parse(message)).not.toThrow();
  expect(messages).toContainEqual({ type: 'prompt_accepted', session: 'session', text: 'hello' });
});
it('rejects untrusted, stale-session and arbitrary command/operation injection before side effects', async () => {
  const { peer, controller, setTrusted } = await setup();
  const count = peer.requests.length;
  setTrusted(false);
  await controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'remove', session: 'session' },
  });
  expect(controller.snapshot.error).toContain('trust');
  setTrusted(true);
  for (const value of [
    { type: 'execute', session: 'session', command: { method: 'remove', session: 'other' } },
    { type: 'execute', session: 'session', command: { method: 'subscribe', session: 'session' } },
    {
      type: 'execute',
      session: 'session',
      command: { method: 'remove', session: 'session' },
      operation: 'injected',
    },
    { type: 'create', command: { method: 'remove', session: 'session' } },
    { type: 'cancel_fork', operation: 'not-active' },
  ]) {
    await controller.receive(value);
    expect(controller.snapshot.error).toBeTruthy();
  }
  expect(peer.requests).toHaveLength(count);
});
it('image bytes require full current transcript membership, never a URL or arbitrary local archive reference', async () => {
  const { peer, controller } = await setup();
  const count = peer.requests.length;
  const ref = imageRef.parse({ id: 'image', mime: 'image/png', bytes: 24, sha256: '0'.repeat(64) });
  await controller.receive({ type: 'read_image', session: 'session', image: ref });
  expect(controller.snapshot.error).toContain('not in this session');
  await controller.receive({ type: 'read_image', session: 'session', path: '/secret' });
  expect(peer.requests).toHaveLength(count);
});
it('fork cancellation uses the original operation while a pending fork observer still owns its quota', async () => {
  const { peer, controller } = await setup();
  const fresh = emptySnapshot(6);
  fresh.transcript.entries.push({
    id: entryId.parse('entry'),
    turn: 'turn' as never,
    role: 'User',
    text: 'hello',
  });
  const reading = controller.receive({ type: 'refresh' });
  await expect.poll(() => peer.requests.length).toBe(4);
  peer.reply(peer.requests[3], [{ SessionsListed: [fresh] }]);
  await expect.poll(() => peer.requests.length).toBe(5);
  peer.reply(peer.requests[4], [{ SessionLoaded: fresh }]);
  await reading;
  const fork = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'fork', session: 'session', request: { entry: 'entry' } },
  });
  await expect.poll(() => peer.requests.length).toBe(6);
  const original = peer.requests[5];
  expect(original.command.method).toBe('fork');
  const cancel = controller.receive({ type: 'cancel_fork', operation: original.operation });
  await expect.poll(() => peer.requests.length).toBe(7);
  expect(peer.requests[6].command).toEqual({
    method: 'cancel_fork',
    session: 'session',
    operation: original.operation,
  });
  expect(peer.requests[6].operation).not.toBe(original.operation);
  for (const request of [original, peer.requests[6]])
    peer.send(request.socket, {
      type: 'error',
      id: request.id,
      code: 'native_fork_uncertain',
      message: 'A remote branch may exist',
    });
  await Promise.all([fork, cancel]);
  expect(
    controller.snapshot.operations.filter((o) => o.code === 'native_fork_uncertain'),
  ).toHaveLength(2);
  expect(controller.snapshot.operations.every((o) => o.status === 'failed')).toBe(true);
  expect(controller.snapshot.operations[0].operation).toBe(original.operation);
});
