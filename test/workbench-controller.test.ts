import { afterEach, expect, it } from 'vitest';
import { WorkbenchController } from '../src/workbench-controller';
import { uiStateMessage, type WorkbenchUiMessage } from '../src/workbench-ui';
import { entryId, imageRef, operationId, sessionId } from '../src/workbench-protocol';
import { emptyView, workbenchPeer } from './helpers/workbench-peer';
function summary(revision = 5) {
  const view = emptyView(revision);
  return {
    id: view.id,
    harness: view.harness,
    cwd: view.cwd,
    status: view.status,
    revision,
    created_seq: 1,
  };
}
function attached(revision = 5, entries: unknown[] = []) {
  const view = emptyView(revision);
  view.last_entry_seq = entries.length;
  return { view, recent_page: { entries, next_cursor: null } };
}
const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
async function setup(
  attachFiles?: (cwd: string) => Promise<import('../src/workbench-input').TextAttachment[]>,
) {
  const peer = await workbenchPeer();
  peers.push(peer);
  const messages: WorkbenchUiMessage[] = [],
    authorization: string[] = [];
  let trusted = true;
  const controller = new WorkbenchController(peer.client(), {
    post: (message) => messages.push(message),
    trusted: () => trusted,
    workspace: () => '/workspace',
    attachFiles,
    authorize: async (cwd) => {
      authorization.push(cwd);
      if (cwd !== '/workspace') throw new Error('outside workspace');
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  const ready = controller.receive({ type: 'ready' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'list', { sessions: [summary()], next_cursor: null });
  await ready;
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.query(peer.requests[1], 'attached', attached());
  await selecting;
  return {
    peer,
    controller,
    messages,
    authorization,
    setTrusted: (value: boolean) => (trusted = value),
  };
}
it('file picking is explicitly authorized, remains cold and rejects trust changes before posting results', async () => {
  let finish!: (files: import('../src/workbench-input').TextAttachment[]) => void;
  const { peer, controller, messages, setTrusted } = await setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const selecting = controller.receive({ type: 'attach_files', session: 'session' });
  await expect.poll(() => typeof finish).toBe('function');
  setTrusted(false);
  finish([{ id: 'f', name: 'a.ts', text: 'data' }]);
  await selecting;
  expect(messages.some((message) => message.type === 'attachments')).toBe(false);
  expect(controller.snapshot.error).toContain('trust');
  expect(peer.requests.map((request) => request.command.method)).toEqual(['list', 'attach']);
});

it('file picking posts only to its selected session without provider mutation', async () => {
  const files = [{ id: 'f', name: 'a.ts', text: 'data' }];
  const { peer, controller, messages } = await setup(async () => files);
  await controller.receive({ type: 'attach_files', session: 'other' });
  expect(messages.some((message) => message.type === 'attachments')).toBe(false);
  await controller.receive({ type: 'attach_files', session: 'session' });
  expect(messages).toContainEqual({ type: 'attachments', session: 'session', files });
  expect(peer.requests.map((request) => request.command.method)).toEqual(['list', 'attach']);
});

it('selection is cold, typed state reaches the webview, and only user mutation explicitly loads a provider', async () => {
  const { peer, controller, messages, authorization } = await setup();
  expect(peer.requests.map((r) => r.command.method)).toEqual(['list', 'attach']);
  expect(authorization).toEqual([]);
  const action = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'prompt', session: 'session', prompt: 'hello' },
  });
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command.method).toBe('load');
  peer.reply(peer.requests[2], { Loaded: { view: emptyView(5) } });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[3].command.method).toBe('prompt');
  expect(peer.requests[3].operation).toBeDefined();
  peer.reply(peer.requests[3], { Accepted: { session: 'session', revision: 6 } });
  await action;
  expect(peer.requests.map((request) => request.command.method)).toEqual([
    'list',
    'attach',
    'load',
    'prompt',
  ]);
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
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'hello' } },
    message: null,
    image: null,
  };
  const reading = controller.receive({ type: 'refresh' });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'list', { sessions: [summary(6)], next_cursor: null });
  await expect.poll(() => peer.requests.length).toBe(4);
  peer.query(peer.requests[3], 'attached', attached(6, [entry]));
  await reading;
  const fork = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'fork', session: 'session', request: { entry: 'entry' } },
  });
  await expect.poll(() => peer.requests.length).toBe(5);
  const original = peer.requests[4];
  expect(original.command.method).toBe('fork');
  const cancel = controller.receive({ type: 'cancel_fork', operation: original.operation });
  await expect.poll(() => peer.requests.length).toBe(6);
  expect(peer.requests[5].command).toEqual({
    method: 'cancel_fork',
    session: 'session',
    operation: original.operation,
  });
  expect(peer.requests[5].operation).not.toBe(original.operation);
  for (const request of [original, peer.requests[5]])
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
  expect(controller.snapshot.operations.every((o) => o.status === 'uncertain')).toBe(true);
  expect(controller.snapshot.operations[0].operation).toBe(original.operation);
});

it('reload recovers handles by ID without sending their original mutations', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const saved = [
    { operation: 'old-prompt', method: 'prompt', session: 'session', status: 'pending' },
  ];
  let persisted: unknown;
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {},
    loadOperations: () => saved,
    saveOperations: async (rows) => {
      persisted = rows;
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  const ready = controller.receive({ type: 'ready' });
  await expect.poll(() => peer.requests.length).toBe(1);
  expect(peer.requests[0].command).toEqual({ method: 'operation', operation: 'old-prompt' });
  expect(peer.requests[0].operation).toBeUndefined();
  peer.query(peer.requests[0], 'operation', {
    status: 'completed',
    receipt: { Accepted: { session: 'session', revision: 6 } },
  });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.query(peer.requests[1], 'list', { sessions: [summary(6)], next_cursor: null });
  await ready;
  expect(controller.snapshot.operations[0].status).toBe('completed');
  expect(persisted).toEqual(controller.snapshot.operations);
  expect(peer.requests.map((r) => r.command.method)).toEqual(['operation', 'list']);
});

it('does not dispatch if durable local handle persistence fails', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {},
    saveOperations: async () => {
      throw new Error('preferences unavailable');
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  await controller.receive({
    type: 'create',
    command: { method: 'create', harness: 'Pi', cwd: '/workspace' },
  });
  expect(peer.requests).toEqual([]);
  expect(controller.snapshot.error).toBe('preferences unavailable');
});
