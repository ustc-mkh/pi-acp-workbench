import { afterEach, expect, it } from 'vitest';
import { WorkbenchSession } from '../src/workbench-session';
import { domainEvent, entryId, sessionId } from '../src/workbench-protocol';
import { emptySnapshot, workbenchPeer, type PeerRequest } from './helpers/workbench-peer';

const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
async function setup() {
  const peer = await workbenchPeer();
  peers.push(peer);
  const client = peer.client(),
    view = new WorkbenchSession(client, sessionId.parse('session'));
  peer.cleanups.push(() => view.stop());
  const starting = view.start();
  await expect
    .poll(() => peer.requests.filter((r) => r.command.method === 'inspect').length)
    .toBe(1);
  const inspect = () => peer.requests.filter((r) => r.command.method === 'inspect');
  peer.reply(inspect()[0], [{ SessionLoaded: emptySnapshot(5) }]);
  await starting;
  return { peer, client, view, inspect };
}
function send(
  peer: Awaited<ReturnType<typeof workbenchPeer>>,
  request: PeerRequest,
  event: unknown,
) {
  peer.send(request.socket, { type: 'event', event: domainEvent.parse(event) });
}
const text = (entry: string, value: string) => ({
  AgentText: {
    session: 'session',
    turn: 'turn',
    entry,
    message: 'opaque group',
    text: value,
  },
});

it('coalesces live identity hints into authoritative cold inspect snapshots without merging rows', async () => {
  const { peer, view, inspect } = await setup();
  expect(view.view.status).toBe('ready');
  const request = inspect()[0];
  send(peer, request, {
    AgentThought: {
      session: 'session',
      turn: 'turn',
      entry: 'thought',
      message: 'opaque group',
      text: 'thinking',
    },
  });
  send(peer, request, text('a', 'hello '));
  send(peer, request, text('b', '世界'));
  await expect.poll(() => view.view.provisional.length).toBe(3);
  expect(view.view.provisional.map((e) => [e.id, e.text])).toEqual([
    ['thought', 'thinking'],
    ['a', 'hello '],
    ['b', '世界'],
  ]);
  expect(view.view.snapshot?.revision).toBe(5);
  const rows = [...view.view.provisional];
  await expect.poll(() => inspect().length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(inspect()).toHaveLength(2);
  const next = emptySnapshot(9);
  next.transcript.entries = rows;
  peer.reply(inspect()[1], [{ SessionLoaded: next }]);
  await expect.poll(() => view.view.status).toBe('ready');
  expect(view.view.provisional).toEqual([]);
  expect(view.view.snapshot?.transcript.entries).toEqual(rows);
  expect(peer.requests.every((r) => ['subscribe', 'inspect'].includes(r.command.method))).toBe(
    true,
  );
  expect(peer.requests.every((r) => !r.operation)).toBe(true);
});

it('never replays old lifecycle events over an authoritative newer snapshot', async () => {
  const { peer, view, inspect } = await setup();
  send(peer, inspect()[0], { TurnStarted: { session: 'session', turn: 'already-finished' } });
  await expect.poll(() => inspect().length).toBe(2);
  const complete = emptySnapshot(10);
  peer.reply(inspect()[1], [{ SessionLoaded: complete }]);
  await expect.poll(() => view.view.status).toBe('ready');
  expect(view.view.snapshot?.status).toBe('Idle');
  expect(view.view.snapshot?.active_turn).toBeNull();
  const refresh = view.refresh();
  await expect.poll(() => inspect().length).toBe(3);
  peer.reply(inspect()[2], [{ SessionLoaded: emptySnapshot(2) }]);
  await refresh;
  expect(view.view.snapshot?.revision).toBe(10);
  await expect.poll(() => inspect().length).toBe(4);
  peer.reply(inspect()[3], [{ SessionLoaded: emptySnapshot(11) }]);
  await expect.poll(() => view.view.snapshot?.revision).toBe(11);
});

it('resync fences an in-flight inspect and clears provisional cut/display evidence', async () => {
  const { peer, view, inspect } = await setup();
  const refresh = view.refresh();
  await expect.poll(() => inspect().length).toBe(2);
  send(peer, inspect()[0], text('unconfirmed', 'old display'));
  await expect.poll(() => view.view.provisional.length).toBe(1);
  peer.send(inspect()[0].socket, { type: 'resync_required' });
  await expect.poll(() => view.view.provisional.length).toBe(0);
  peer.reply(inspect()[1], [{ SessionLoaded: emptySnapshot(100) }]);
  await refresh;
  expect(view.view.snapshot?.revision).toBe(5);
  expect(view.view.status).toBe('stale');
  await expect.poll(() => inspect().length).toBe(3);
  peer.reply(inspect()[2], [{ SessionLoaded: emptySnapshot(101) }]);
  await expect.poll(() => view.view.status).toBe('ready');
  expect(view.view.snapshot?.revision).toBe(101);
});

it('source deletion wins over late inspect and does not load a missing actor', async () => {
  const { peer, view, inspect } = await setup();
  const refresh = view.refresh();
  await expect.poll(() => inspect().length).toBe(2);
  send(peer, inspect()[0], { SessionRemoved: 'session' });
  await expect.poll(() => view.view.status).toBe('removed');
  peer.reply(inspect()[1], [{ SessionLoaded: emptySnapshot(100) }]);
  await refresh;
  expect(view.view.status).toBe('removed');
  expect(view.view.snapshot).toBeUndefined();
  expect(peer.requests.some((r) => r.command.method === 'load')).toBe(false);
});

it('disconnect requires a fresh attachment and stop does not reconnect to unsubscribe', async () => {
  const { peer, view, inspect } = await setup();
  inspect()[0].socket.destroy();
  await expect.poll(() => view.view.status).toBe('disconnected');
  await expect(view.start()).rejects.toThrow('new session view');
  const count = peer.requests.length;
  await view.stop();
  expect(peer.requests).toHaveLength(count);
  expect(peer.sockets.size).toBe(0);
});

it('caps provisional rows and bytes while continuing cold resynchronization', async () => {
  const { peer, view, inspect } = await setup();
  for (let i = 0; i < 300; i++) send(peer, inspect()[0], text(`entry-${i}`, 'x'));
  await expect.poll(() => view.view.provisional.length).toBe(256);
  send(peer, inspect()[0], text('too-large', 'x'.repeat(1024 * 1024 + 1)));
  await expect.poll(() => inspect().length).toBe(2);
  const next = emptySnapshot(8);
  next.transcript.entries = [
    {
      id: entryId.parse('confirmed'),
      turn: view.view.provisional[0].turn,
      role: 'Agent',
      text: 'authoritative',
      message: undefined,
    },
  ];
  peer.reply(inspect()[1], [{ SessionLoaded: next }]);
  // It may schedule a second inspect if the final oversized event arrived during the first.
  await expect.poll(() => view.view.snapshot?.revision).toBe(8);
  expect(view.view.provisional.length).toBeLessThanOrEqual(256);
  expect(view.view.provisional.some((row) => row.id === 'too-large')).toBe(false);
});
