import { afterEach, expect, it } from 'vitest';
import { WorkbenchController } from '../src/workbench-controller';
import { emptyView, workbenchPeer } from './helpers/workbench-peer';

const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
async function setup(saved: unknown[] = []) {
  const peer = await workbenchPeer();
  peers.push(peer);
  const controller = new WorkbenchController(peer.client(), {
    post: () => {},
    trusted: () => true,
    workspace: () => '/workspace',
    authorize: async () => {
      throw new Error('No mutation during recovery');
    },
    loadOperations: () => saved,
  });
  peer.cleanups.push(async () => controller.dispose());
  return { peer, controller };
}
const attached = (revision = 1) => ({
  view: emptyView(revision),
  recent_page: { entries: [], next_cursor: null },
});

it('concurrent receipt recovery shares one bounded query and does not resend an unknown operation', async () => {
  const { peer, controller } = await setup([
    { operation: 'original', method: 'prompt', session: 'session', status: 'pending' },
  ]);
  const first = controller.receive({ type: 'recover_operations' });
  const second = controller.receive({ type: 'recover_operations' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'operation', { status: 'unknown' });
  await Promise.all([first, second]);
  expect(peer.requests.map((request) => request.command)).toEqual([
    { method: 'operation', operation: 'original' },
  ]);
  expect(controller.snapshot.operations[0].status).toBe('uncertain');
  expect(controller.snapshot.operations[0].error).toContain('No request was resent');
});

it('revision gaps trigger a fresh attach snapshot without a provider load', async () => {
  const { peer, controller } = await setup();
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  peer.send(peer.requests[0].socket, { type: 'resync_required' });
  await expect.poll(() => controller.snapshot.view?.status).toBe('stale');
  await expect.poll(() => peer.requests.length, { timeout: 3000 }).toBe(2);
  peer.query(peer.requests[1], 'attached', attached(7));
  await expect.poll(() => controller.snapshot.view?.view?.revision).toBe(7);
  expect(controller.snapshot.view?.status).toBe('ready');
  expect(peer.requests.map((request) => request.command.method)).toEqual(['attach', 'attach']);
});

it('switching sessions fences a late reconnect snapshot and leaves the new session selected', async () => {
  const { peer, controller } = await setup();
  const selecting = controller.receive({ type: 'select', session: 'session' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'attached', attached());
  await selecting;
  peer.requests[0].socket.destroy();
  await expect.poll(() => peer.requests.length, { timeout: 3000 }).toBe(2);
  expect(peer.requests[1].command.method).toBe('attach');
  const switching = controller.receive({ type: 'select', session: 'other' });
  await expect.poll(() => peer.requests.length).toBe(4);
  expect(peer.requests[2].command.method).toBe('detach');
  const other = attached(8);
  other.view.id = 'other' as typeof other.view.id;
  peer.query(peer.requests[3], 'attached', other);
  await switching;
  peer.query(peer.requests[1], 'attached', attached(99));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(controller.snapshot.selected).toBe('other');
  expect(controller.snapshot.view?.view?.revision).toBe(8);
  expect(controller.snapshot.view?.status).toBe('ready');
  expect(peer.requests.every((request) => !request.operation)).toBe(true);
});
