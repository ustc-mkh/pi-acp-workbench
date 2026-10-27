import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
  confirmUndo?: (session: string, turn: string) => Promise<boolean>,
  entries: unknown[] = [],
  copyText?: (text: string) => PromiseLike<void>,
  archiveText?: string,
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
    confirmUndo,
    copyText,
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
  peer.query(peer.requests[1], 'attached', attached(5, entries));
  if (archiveText !== undefined) {
    await expect.poll(() => peer.requests.length).toBe(3);
    expect(peer.requests[2].command).toMatchObject({ method: 'content', offset: 0 });
    peer.query(peer.requests[2], 'content', {
      text: archiveText,
      total_bytes: Buffer.byteLength(archiveText),
      sha256: createHash('sha256').update(archiveText).digest('hex'),
      next_offset: null,
    });
  }
  await selecting;
  return {
    peer,
    controller,
    messages,
    authorization,
    setTrusted: (value: boolean) => (trusted = value),
  };
}
it('copies immutable image identity instead of silently copying an empty image entry', async () => {
  const image = { id: 'image', mime: 'image/png', bytes: 24, sha256: 'a'.repeat(64) };
  const copied: string[] = [];
  const { controller, peer } = await setup(
    undefined,
    undefined,
    [
      {
        seq: 1,
        id: 'entry',
        turn: 'turn',
        role: 'User',
        text: { Inline: { text: '' } },
        message: null,
        image,
      },
    ],
    async (text) => {
      copied.push(text);
    },
  );
  await controller.receive({ type: 'copy_message', session: 'session', entry: 'entry' });
  expect(copied).toEqual([`[Archived image: image; image/png; 24 bytes; ${image.sha256}]`]);
  expect(peer.requests).toHaveLength(2);
});
it('copies only a confirmed message with exact bounded content cursors and checksum', async () => {
  const text = '你好🌍';
  const ref = {
    id: 'body',
    kind: 'Text',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
  const entry = {
    seq: 1,
    id: 'entry',
    turn: 'turn',
    role: 'Agent',
    text: { Archived: { content: ref } },
    message: null,
    image: null,
  };
  const copied: string[] = [];
  const { peer, controller } = await setup(
    undefined,
    undefined,
    [entry],
    async (text) => {
      copied.push(text);
    },
    text,
  );
  expect(controller.snapshot.view?.resolvedText).toEqual({ body: text });
  const baseline = peer.requests.length;
  let action = controller.receive({ type: 'copy_message', session: 'session', entry: 'entry' });
  await expect.poll(() => peer.requests.length).toBe(baseline + 1);
  peer.query(peer.requests[baseline], 'content', {
    text: '你好',
    sha256: ref.sha256,
    total_bytes: ref.bytes,
    next_offset: 6,
  });
  await expect.poll(() => peer.requests.length).toBe(baseline + 2);
  peer.query(peer.requests[baseline + 1], 'content', {
    text: '🌍',
    sha256: ref.sha256,
    total_bytes: ref.bytes,
    next_offset: null,
  });
  await action;
  expect(copied).toEqual([text]);
  action = controller.receive({ type: 'copy_message', session: 'session', entry: 'entry' });
  await expect.poll(() => peer.requests.length).toBe(baseline + 3);
  peer.query(peer.requests[baseline + 2], 'content', {
    text: '你好',
    sha256: ref.sha256,
    total_bytes: ref.bytes,
    next_offset: 1,
  });
  await action;
  expect(copied).toEqual([text]);
  expect(controller.snapshot.error).toContain('cursor');
});
it('reads only a turn diff whose turn is present in the selected committed page', async () => {
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'prompt' } },
    message: null,
    image: null,
  };
  const { peer, controller, messages } = await setup(undefined, undefined, [entry]);
  const reading = controller.receive({ type: 'read_turn_diff', session: 'session', turn: 'turn' });
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command.method).toBe('turn_diff');
  peer.query(peer.requests[2], 'turn_diff', {
    status: 'complete',
    files: [],
    warnings: [],
    added: 0,
    removed: 0,
    next_offset: null,
  });
  await reading;
  expect(messages).toContainEqual(
    expect.objectContaining({ type: 'turn_diff', session: 'session', turn: 'turn' }),
  );
  const count = peer.requests.length;
  await controller.receive({ type: 'read_turn_diff', session: 'session', turn: 'not-visible' });
  expect(peer.requests).toHaveLength(count);
});
it('reads paged diff content through the selected turn identity', async () => {
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'prompt' } },
    message: null,
    image: null,
  };
  const { peer, controller, messages } = await setup(undefined, undefined, [entry]);
  const diffRead = controller.receive({ type: 'read_turn_diff', session: 'session', turn: 'turn' });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'turn_diff', {
    status: 'complete',
    files: [
      {
        path: 'large.txt',
        status: 'modified',
        before_hash: 'a'.repeat(64),
        after_hash: 'b'.repeat(64),
        before: null,
        after: null,
        old_mode: 33188,
        new_mode: 33188,
        added: 1,
        removed: 1,
        patch: null,
        omitted: 'large',
      },
    ],
    warnings: [],
    added: 1,
    removed: 1,
    next_offset: null,
  });
  await diffRead;
  const contentRead = controller.receive({
    type: 'read_turn_diff_content',
    session: 'session',
    turn: 'turn',
    file: 0,
    after: true,
    offset: 0,
  });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[3].command.method).toBe('turn_diff_content');
  peer.query(peer.requests[3], 'turn_diff_content', {
    bytes: 'large content',
    total_bytes: 13,
    next_offset: null,
  });
  await contentRead;
  expect(messages).toContainEqual(
    expect.objectContaining({ type: 'turn_diff_content', bytes: 'large content' }),
  );
});
it('requires editor confirmation and sends undo as one durable command with an operation identity', async () => {
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'prompt' } },
    message: null,
    image: null,
  };
  const confirmations: string[] = [];
  const { peer, controller, messages } = await setup(
    undefined,
    async (session, turn) => {
      confirmations.push(`${session}:${turn}`);
      return true;
    },
    [entry],
  );
  const undo = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command.method).toBe('validate_undo');
  peer.query(peer.requests[2], 'validate_undo', { files: [] });
  await expect.poll(() => peer.requests.length).toBe(4);
  const request = peer.requests[3];
  expect(request.command.method).toBe('undo_turn');
  expect(request.operation).toBeDefined();
  expect(confirmations).toEqual(['session:turn']);
  peer.reply(request, {
    UndoCompleted: {
      session: 'session',
      report: { files: [{ path: 'a.txt', status: 'restored', error: null }] },
    },
  });
  await undo;
  expect(messages).toContainEqual({
    type: 'undo_result',
    session: 'session',
    turn: 'turn',
    report: { files: [{ path: 'a.txt', status: 'restored', error: null }] },
  });
});
it('rechecks workspace authorization after modal confirmation before undo admission', async () => {
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'prompt' } },
    message: null,
    image: null,
  };
  let approve!: (value: boolean) => void;
  const { peer, controller, setTrusted } = await setup(
    undefined,
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    [entry],
  );
  const action = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'validate_undo', { files: [] });
  await expect.poll(() => typeof approve).toBe('function');
  await controller.receive({ type: 'select', session: 'another-session' });
  await controller.receive({
    type: 'execute',
    session: 'session',
    command: {
      method: 'prompt',
      session: 'session',
      prompt: { parts: [{ type: 'text', text: 'must not dispatch during confirmation' }] },
    },
  });
  expect(peer.requests).toHaveLength(3);
  expect(controller.snapshot.error).toContain('confirmation');
  setTrusted(false);
  approve(true);
  await action;
  expect(peer.requests.map((r) => r.command.method)).toEqual(['list', 'attach', 'validate_undo']);
  expect(controller.snapshot.error).toContain('trust');
});
it('canceled editor confirmation never admits an undo operation', async () => {
  const entry = {
    seq: 1,
    id: entryId.parse('entry'),
    turn: 'turn',
    role: 'User',
    text: { Inline: { text: 'prompt' } },
    message: null,
    image: null,
  };
  const { peer, controller } = await setup(undefined, async () => false, [entry]);
  const action = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'undo_turn', session: 'session', turn: 'turn' },
  });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'validate_undo', { files: [] });
  await action;
  expect(peer.requests.map((r) => r.command.method)).toEqual(['list', 'attach', 'validate_undo']);
});

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

it('new session subscribes and discovers concurrently and uses the confirmed empty receipt without reattaching', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {},
  });
  peer.cleanups.push(async () => controller.dispose());
  const action = controller.receive({
    type: 'create',
    command: { method: 'create', harness: 'Pi', cwd: '/workspace' },
  });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.reply(peer.requests[0], { Created: { summary: summary() } });
  // Discovery must start even while the initial subscription is still blocked.
  await expect.poll(() => peer.requests.length).toBe(3);
  const attach = peer.requests.find((r) => r.command.method === 'attach')!;
  const discover = peer.requests.find((r) => r.command.method === 'discover')!;
  expect(controller.snapshot.preparing).toBe('session');
  peer.reply(discover, { Loaded: { view: emptyView(6) } });
  peer.query(attach, 'attached', attached(5));
  await action;
  expect(controller.snapshot.preparing).toBeUndefined();
  expect(controller.snapshot.view?.status).toBe('ready');
  expect(controller.snapshot.view?.view?.revision).toBe(6);
  expect(peer.requests.map((r) => r.command.method)).toEqual(['create', 'attach', 'discover']);
});

it('removes an unselected session without loading it or changing selection', async () => {
  const { peer, controller } = await setup();
  const action = controller.receive({ type: 'remove_session', session: 'other' });
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command).toEqual({ method: 'inspect', session: 'other' });
  peer.query(peer.requests[2], 'view', { ...emptyView(), id: 'other' });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[3].command).toEqual({ method: 'remove', session: 'other' });
  peer.reply(peer.requests[3], { Accepted: { session: 'other', revision: 1 } });
  await action;
  expect(controller.snapshot.selected).toBe('session');
  expect(peer.requests.map((x) => x.command.method)).toEqual([
    'list',
    'attach',
    'inspect',
    'remove',
  ]);
});

it('releases an unselected session through its authorized cancel receipt without loading or removing it', async () => {
  const { peer, controller } = await setup();
  const action = controller.receive({ type: 'release_session', session: 'other' });
  await expect.poll(() => peer.requests.length).toBe(3);
  expect(peer.requests[2].command).toEqual({ method: 'inspect', session: 'other' });
  peer.query(peer.requests[2], 'view', { ...emptyView(), id: 'other' });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[3].command).toEqual({ method: 'cancel', session: 'other', release: true });
  peer.reply(peer.requests[3], { Accepted: { session: 'other', revision: 1 } });
  await expect.poll(() => peer.requests.length).toBe(5);
  peer.query(peer.requests[4], 'list', { sessions: [summary()], next_cursor: null });
  await action;
  expect(controller.snapshot.selected).toBe('session');
  expect(peer.requests.map((x) => x.command.method)).toEqual([
    'list',
    'attach',
    'inspect',
    'cancel',
    'list',
  ]);
});

it('does not release a running session without confirmation or a session outside the authorized workspace', async () => {
  const { peer, controller } = await setup();
  const active = controller.receive({ type: 'release_session', session: 'other' });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'view', {
    ...emptyView(),
    id: 'other',
    status: 'Running',
    active_turn: 'live-turn',
  });
  await active;
  expect(controller.snapshot.error).toContain('再次确认');
  const outside = controller.receive({
    type: 'release_session',
    session: 'outside',
    confirmed: true,
  });
  await expect.poll(() => peer.requests.length).toBe(4);
  peer.query(peer.requests[3], 'view', { ...emptyView(), id: 'outside', cwd: '/forbidden' });
  await outside;
  expect(controller.snapshot.error).toContain('outside workspace');
  expect(
    peer.requests.some((r) => r.command.method === 'cancel' || r.command.method === 'load'),
  ).toBe(false);
});

it('selection is cold, typed state reaches the webview, and only user mutation explicitly loads a provider', async () => {
  const { peer, controller, messages, authorization } = await setup();
  expect(peer.requests.map((r) => r.command.method)).toEqual(['list', 'attach']);
  expect(authorization).toEqual([]);
  const action = controller.receive({
    type: 'execute',
    session: 'session',
    command: {
      method: 'prompt',
      session: 'session',
      prompt: { parts: [{ type: 'text', text: 'hello' }] },
    },
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
  expect(messages).toContainEqual({
    type: 'prompt_accepted',
    session: 'session',
    prompt: { parts: [{ type: 'text', text: 'hello' }] },
    generation: undefined,
    operation: expect.any(String),
    pi_after_seq: 0,
  });
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

it.each([47, 63, 64])(
  'retains all %i uncertain handles rather than silently evicting reload recovery identities',
  async (count) => {
    const peer = await workbenchPeer();
    peers.push(peer);
    const saved = Array.from({ length: count }, (_, i) => ({
      operation: `uncertain-${i}`,
      method: 'prompt',
      session: 'session',
      status: 'uncertain',
    }));
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
    const action = controller.receive({
      type: 'create',
      command: { method: 'create', harness: 'Pi', cwd: '/workspace' },
    });
    if (count < 48) {
      await expect.poll(() => peer.requests.length).toBe(1);
      peer.send(peer.requests[0].socket, {
        type: 'error',
        id: peer.requests[0].id,
        code: 'provider_not_configured',
        message: 'Provider unavailable',
      });
    }
    await action;
    expect(controller.snapshot.operations.slice(0, count)).toMatchObject(saved);
    expect(controller.snapshot.operations.length).toBeLessThanOrEqual(64);
    if (count >= 48) {
      expect(peer.requests).toEqual([]);
      expect(controller.snapshot.error).toContain('uncertain operation receipts');
    } else expect(persisted).toEqual(controller.snapshot.operations);
  },
);

it('keeps reserved receipt capacity for control commands when ordinary workflows are blocked', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const saved = Array.from({ length: 63 }, (_, i) => ({
    operation: `uncertain-${i}`,
    method: 'prompt',
    session: 'session',
    status: 'uncertain',
  }));
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {},
    loadOperations: () => saved,
  });
  peer.cleanups.push(async () => controller.dispose());
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  const cancel = controller.receive({
    type: 'execute',
    session: 'session',
    command: { method: 'cancel', session: 'session' },
  });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.reply(peer.requests[1], { Accepted: { session: 'session', revision: 6 } });
  await cancel;
  expect(controller.snapshot.operations.slice(0, 63)).toMatchObject(saved);
  expect(controller.snapshot.operations).toHaveLength(64);
  expect(controller.snapshot.operations[63]).toMatchObject({
    method: 'cancel',
    status: 'completed',
  });
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

it('detaches the view when switching to an empty harness without cancelling or creating provider work', async () => {
  const { controller, peer } = await setup();
  const before = peer.requests.length;
  await controller.receive({ type: 'clear_selection' });
  expect(controller.snapshot.selected).toBeUndefined();
  expect(controller.snapshot.view).toBeUndefined();
  await expect.poll(() => peer.requests.length).toBe(before + 1);
  expect(peer.requests.slice(before).map((request) => request.command.method)).toEqual(['detach']);
  await controller.receive({ type: 'clear_selection' });
  expect(peer.requests).toHaveLength(before + 1);
});

it('copies selected plain text through the host clipboard without issuing a provider request', async () => {
  const copied: string[] = [];
  const { controller, peer } = await setup(undefined, undefined, [], async (text) => {
    copied.push(text);
  });
  const before = peer.requests.length;
  await controller.receive({ type: 'copy_text', text: '选中的文字\nconst x = 1;' });
  expect(copied).toEqual(['选中的文字\nconst x = 1;']);
  expect(peer.requests).toHaveLength(before);
});

it('opens and initializes a new session without waiting for the previous session detach acknowledgement', async () => {
  const peer = await workbenchPeer({ autoDetach: false });
  peers.push(peer);
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {},
  });
  peer.cleanups.push(async () => controller.dispose());
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  const action = controller.receive({
    type: 'create',
    command: { method: 'create', harness: 'Pi', cwd: '/workspace' },
  });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.reply(peer.requests[1], { Created: { summary: { ...summary(), id: 'new-session' } } });
  await expect.poll(() => peer.requests.length).toBe(5);
  const detach = peer.requests.find((r) => r.command.method === 'detach')!;
  const attach = peer.requests.find(
    (r) => r.command.method === 'attach' && r.command.session === 'new-session',
  )!;
  const discover = peer.requests.find((r) => r.command.method === 'discover')!;
  peer.query(attach, 'attached', { ...attached(), view: { ...emptyView(5), id: 'new-session' } });
  peer.reply(discover, { Loaded: { view: { ...emptyView(6), id: 'new-session' } } });
  await action;
  expect(controller.snapshot.selected).toBe('new-session');
  expect(controller.snapshot.view?.view?.revision).toBe(6);
  expect(controller.snapshot.preparing).toBeUndefined();
  peer.send(detach.socket, { type: 'detached', id: detach.id, session: 'session' });
  expect(peer.requests.filter((r) => r.command.method === 'attach')).toHaveLength(2);
});

it('coalesces page metadata refreshes without a selected session and reads each statistics query afterwards', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const messages: WorkbenchUiMessage[] = [];
  const controller = new WorkbenchController(peer.client(), {
    post: (m) => messages.push(m),
    trusted: () => true,
    workspace: () => undefined,
    authorize: async () => {
      throw new Error('No session authorization should be requested');
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  const data = {
    models: [],
    naming_policy: 'follow',
    title_model: null,
    groups: [],
    totals: null,
    next_cursor: null,
  };
  const first = controller.receive({
    type: 'read_management',
    request_id: 1,
    query: {},
    refresh_models: true,
  });
  const second = controller.receive({
    type: 'read_management',
    request_id: 2,
    query: { group: 'model' },
    refresh_models: true,
  });
  await expect.poll(() => peer.requests.length).toBe(1);
  expect(peer.requests[0].command).toEqual({
    method: 'management',
    query: {},
    refresh_models: true,
  });
  peer.query(peer.requests[0], 'management', data);
  await expect.poll(() => peer.requests.length).toBe(3);
  for (const request of peer.requests.slice(1)) peer.query(request, 'management', data);
  await Promise.all([first, second]);
  expect(messages.filter((m) => m.type === 'management')).toHaveLength(2);
  expect(peer.requests.every((r) => r.command.method === 'management')).toBe(true);
});

it('keeps cached statistics available in an untrusted workspace without starting metadata workers', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const messages: WorkbenchUiMessage[] = [];
  const controller = new WorkbenchController(peer.client(), {
    post: (m) => messages.push(m),
    trusted: () => false,
    workspace: () => undefined,
    authorize: async () => {
      throw new Error('No authorization expected');
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  const action = controller.receive({
    type: 'read_management',
    request_id: 1,
    query: { group: 'model' },
    refresh_models: true,
  });
  await expect.poll(() => peer.requests.length).toBe(1);
  expect(peer.requests[0].command).toEqual({ method: 'management', query: { group: 'model' } });
  peer.query(peer.requests[0], 'management', {
    models: [],
    naming_policy: 'follow',
    title_model: null,
    groups: [],
    totals: null,
    next_cursor: null,
  });
  await action;
  expect(messages.some((m) => m.type === 'management')).toBe(true);
});
