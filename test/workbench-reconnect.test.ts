import { afterEach, expect, it } from 'vitest';
import { WorkbenchController } from '../src/workbench-controller';
import { WorkbenchError } from '../src/workbench-client';
import { emptyView, workbenchPeer } from './helpers/workbench-peer';

const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
async function setup(savedSelection?: unknown) {
  const peer = await workbenchPeer();
  peers.push(peer);
  let saved: unknown = savedSelection;
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {
      throw new Error('Recovery must not authorize provider mutations');
    },
    loadSelection: () => saved,
    saveSelection: async (session) => {
      saved = session;
    },
  });
  peer.cleanups.push(async () => controller.dispose());
  return { peer, controller, saved: () => saved };
}
function attached(revision = 1) {
  return { view: emptyView(revision), recent_page: { entries: [], next_cursor: null } };
}

it('reload restores only a validated session handle using cold attach, not provider load', async () => {
  const { peer, controller } = await setup('session');
  const ready = controller.receive({ type: 'ready' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'list', { sessions: [], next_cursor: null });
  await expect.poll(() => peer.requests.length).toBe(2);
  expect(peer.requests[1].command).toEqual({ method: 'attach', session: 'session' });
  peer.query(peer.requests[1], 'attached', attached(9));
  await ready;
  expect(controller.snapshot.selected).toBe('session');
  expect(controller.snapshot.view?.view?.revision).toBe(9);
  expect(controller.snapshot.view?.status).toBe('ready');
  expect(peer.requests.every((request) => !request.operation)).toBe(true);
});

it('invalid saved state cannot inject a command or prevent cold list startup', async () => {
  const { peer, controller } = await setup({ method: 'load', session: 'session' });
  const ready = controller.receive({ type: 'ready' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'list', { sessions: [], next_cursor: null });
  await ready;
  expect(controller.snapshot.selected).toBeUndefined();
  expect(peer.requests.map((request) => request.command.method)).toEqual(['list']);
});

it('manual Refresh reattaches a disconnected selection and persists just its ID', async () => {
  const { peer, controller, saved } = await setup();
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  expect(saved()).toBe('session');
  peer.requests[0].socket.destroy();
  await expect.poll(() => controller.snapshot.view?.status).toBe('disconnected');
  const refresh = controller.receive({ type: 'refresh' });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.query(peer.requests[1], 'list', { sessions: [], next_cursor: null });
  await expect.poll(() => peer.requests.length).toBe(3);
  peer.query(peer.requests[2], 'attached', attached(4));
  await refresh;
  expect(controller.snapshot.view?.status).toBe('ready');
  expect(controller.snapshot.view?.view?.revision).toBe(4);
  expect(controller.snapshot.error).toBeUndefined();
});

it('disconnect recovers an unknown prompt receipt and observation without replaying mutations', async () => {
  const peer = await workbenchPeer();
  peers.push(peer);
  const client = peer.client();
  const controller = new WorkbenchController(client, {
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
  const sending = controller.receive({
    type: 'execute',
    session: 'session',
    command: {
      method: 'prompt',
      session: 'session',
      prompt: { parts: [{ type: 'text', text: 'never replay' }] },
    },
  });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.reply(peer.requests[1], { Loaded: { view: emptyView() } });
  await expect.poll(() => peer.requests.length).toBe(3);
  const original = peer.requests[2];
  original.socket.destroy();
  await sending;
  expect(controller.snapshot.operations.at(-1)?.status).toBe('uncertain');
  await expect.poll(() => peer.requests.length, { timeout: 3000 }).toBe(4);
  expect(peer.requests[3].command).toEqual({ method: 'operation', operation: original.operation });
  peer.query(peer.requests[3], 'operation', {
    status: 'completed',
    receipt: { Accepted: { session: 'session', revision: 2 } },
  });
  await expect.poll(() => peer.requests.length).toBe(5);
  peer.query(peer.requests[4], 'attached', attached(2));
  await expect.poll(() => controller.snapshot.view?.status).toBe('ready');
  expect(controller.snapshot.operations.at(-1)?.status).toBe('completed');
  expect(peer.requests.map((request) => request.command.method)).toEqual([
    'attach',
    'load',
    'prompt',
    'operation',
    'attach',
  ]);
  expect(peer.requests.slice(3).every((request) => !request.operation)).toBe(true);
});

it('dispose cancels scheduled reconnect and does not create new sockets or requests', async () => {
  const { peer, controller } = await setup();
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  peer.requests[0].socket.destroy();
  await expect.poll(() => controller.snapshot.view?.status).toBe('disconnected');
  controller.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(peer.requests).toHaveLength(1);
  expect(peer.sockets.size).toBe(0);
  await expect(controller.client.call({ method: 'list' })).rejects.toBeInstanceOf(WorkbenchError);
});
