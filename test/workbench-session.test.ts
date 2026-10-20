import { afterEach, expect, it } from 'vitest';
import { WorkbenchSession } from '../src/workbench-session';
import { commitBatch, entryHeader, sessionId, type CommitBatch } from '../src/workbench-protocol';
import { emptyView, workbenchPeer, type PeerRequest } from './helpers/workbench-peer';
const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});
function batch(revision: number, entry?: number): CommitBatch {
  const view = emptyView(revision);
  view.last_entry_seq = entry ?? 0;
  return commitBatch.parse({
    session: view.id,
    revision,
    view,
    entries: entry
      ? [
          entryHeader.parse({
            seq: entry,
            id: `entry-${entry}`,
            turn: 'turn',
            role: 'Agent',
            message: 'opaque group',
            text: { Inline: { text: `text-${entry}` } },
            image: null,
          }),
        ]
      : [],
    tools: [],
    removed: false,
  });
}
function send(
  peer: Awaited<ReturnType<typeof workbenchPeer>>,
  request: PeerRequest,
  value: CommitBatch,
) {
  peer.send(request.socket, { type: 'batch', batch: value });
}
async function setup(complete = true) {
  const peer = await workbenchPeer();
  peers.push(peer);
  const client = peer.client(),
    view = new WorkbenchSession(client, sessionId.parse('session'));
  peer.cleanups.push(() => view.stop());
  const starting = view.start();
  const attaches = () => peer.requests.filter((request) => request.command.method === 'attach');
  await expect.poll(() => attaches().length).toBe(1);
  if (complete) {
    peer.query(attaches()[0], 'attached', {
      view: emptyView(5),
      recent_page: { entries: [], next_cursor: null },
    });
    await starting;
  }
  return { peer, view, attaches, starting };
}
it('500 confirmed updates replace hot view and append bounded headers with zero inspect requests', async () => {
  const { peer, view, attaches } = await setup();
  for (let i = 1; i <= 500; i++) send(peer, attaches()[0], batch(i + 5, i));
  await expect.poll(() => view.view.view?.revision).toBe(505);
  expect(view.view.status).toBe('ready');
  expect(view.view.entries).toHaveLength(500);
  expect(view.view.entries[0].seq).toBe(1);
  expect(view.view.entries.at(-1)?.seq).toBe(500);
  expect(peer.requests.map((request) => request.command.method)).toEqual(['attach']);
  expect(peer.requests.every((request) => !request.operation)).toBe(true);
});
it('attach buffers subsequent batches, discards revisions already in snapshot and preserves confirmed identities', async () => {
  const { peer, view, attaches, starting } = await setup(false);
  send(peer, attaches()[0], batch(4));
  send(peer, attaches()[0], batch(5));
  send(peer, attaches()[0], batch(6, 1));
  peer.query(attaches()[0], 'attached', {
    view: emptyView(5),
    recent_page: { entries: [], next_cursor: null },
  });
  await starting;
  await expect.poll(() => view.view.view?.revision).toBe(6);
  expect(view.view.entries.map((entry) => entry.id)).toEqual(['entry-1']);
  send(peer, attaches()[0], batch(6, 1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(view.view.entries).toHaveLength(1);
  expect(view.view.status).toBe('ready');
});
it('gaps and resync fence in-flight attach, requiring explicit reattach without mutation retry', async () => {
  const { peer, view, attaches } = await setup();
  send(peer, attaches()[0], batch(7));
  await expect.poll(() => view.view.status).toBe('stale');
  expect(view.view.view?.revision).toBe(5);
  expect(attaches()).toHaveLength(1);
  const refreshing = view.refresh();
  await expect.poll(() => attaches().length).toBe(2);
  peer.send(attaches()[0].socket, { type: 'resync_required' });
  peer.query(attaches()[1], 'attached', {
    view: emptyView(100),
    recent_page: { entries: [], next_cursor: null },
  });
  await refreshing;
  expect(view.view.status).toBe('stale');
  expect(view.view.view?.revision).toBe(5);
  expect(peer.requests.some((request) => request.operation)).toBe(false);
});
it('terminal revision removes the page and late duplicate batches cannot resurrect it', async () => {
  const { peer, view, attaches } = await setup();
  send(
    peer,
    attaches()[0],
    commitBatch.parse({
      session: 'session',
      revision: 6,
      view: null,
      entries: [],
      tools: [],
      removed: true,
    }),
  );
  await expect.poll(() => view.view.status).toBe('removed');
  send(peer, attaches()[0], batch(7));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(view.view.status).toBe('removed');
  expect(view.view.view).toBeUndefined();
  expect(view.view.entries).toEqual([]);
  expect(peer.requests.some((request) => request.command.method === 'load')).toBe(false);
});
it('disconnect requires explicit reattachment and stopping does not reconnect for detach', async () => {
  const { peer, view, attaches } = await setup();
  attaches()[0].socket.destroy();
  await expect.poll(() => view.view.status).toBe('disconnected');
  const count = peer.requests.length;
  await view.stop();
  expect(peer.requests).toHaveLength(count);
  expect(peer.sockets.size).toBe(0);
});
it('earlier browsing preserves current messages while current batches only update the hot view', async () => {
  const { peer, view, attaches } = await setup(false);
  const snapshot = emptyView(5);
  snapshot.last_entry_seq = 400;
  const cursor = { version: 3, session: snapshot.id, max_entry_seq: 400, before_seq: 201 };
  peer.query(attaches()[0], 'attached', {
    view: snapshot,
    recent_page: { entries: [batch(5, 201).entries[0]], next_cursor: cursor },
  });
  await view.start();
  const earlier = view.earlier();
  await expect
    .poll(() => peer.requests.filter((request) => request.command.method === 'history').length)
    .toBe(1);
  const request = peer.requests.at(-1)!;
  expect(request.command).toMatchObject({ method: 'history', cursor, limit: 200 });
  peer.query(request, 'history', { entries: [batch(5, 1).entries[0]], next_cursor: null });
  await earlier;
  send(peer, attaches()[0], batch(6, 401));
  await expect.poll(() => view.view.view?.revision).toBe(6);
  expect(view.view.entries.map((entry) => entry.seq)).toEqual([1, 201]);
  expect(view.view.historical).toBe(true);
  const latest = view.latest();
  await expect
    .poll(() => peer.requests.filter((request) => request.command.method === 'attach').length)
    .toBe(2);
  peer.query(peer.requests.at(-1)!, 'attached', {
    view: { ...snapshot, revision: 6, last_entry_seq: 401 },
    recent_page: { entries: [batch(6, 401).entries[0]], next_cursor: null },
  });
  await latest;
  expect(view.view.entries.map((entry) => entry.seq)).toEqual([401]);
  expect(view.view.historical).toBe(false);
});
