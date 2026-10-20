import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { WorkbenchError, WORKBENCH_LIMITS } from '../src/workbench-client';
import {
  clientCommand,
  commitBatch,
  entryId,
  imageRef,
  operationId,
  sessionId,
  sessionView,
} from '../src/workbench-protocol';
import { emptyView, workbenchPeer } from './helpers/workbench-peer';
const accepted = { Accepted: { session: sessionId.parse('session'), revision: 1 } };

const peers: Awaited<ReturnType<typeof workbenchPeer>>[] = [];
async function fixture() {
  const peer = await workbenchPeer();
  peers.push(peer);
  return peer;
}
const session = sessionId.parse('session');
const query = { method: 'inspect' as const, session };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const partialMs = WORKBENCH_LIMITS.partialMs;
afterEach(async () => {
  WORKBENCH_LIMITS.partialMs = partialMs;
  for (const peer of peers.splice(0)) await peer.close();
});

it('correlates out-of-order replies, live events and resync without a legacy envelope', async () => {
  const peer = await fixture(),
    client = peer.client();
  const events: unknown[] = [];
  let resync = 0,
    observerErrors = 0;
  client.observe({
    batch() {
      throw new Error('bad UI observer');
    },
    observerError() {
      observerErrors++;
    },
  });
  client.observe({ batch: (batch) => events.push(batch), resync: () => resync++ });
  const operation = operationId.parse('stable-operation');
  const first = client.request(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'hello 世界' }] } },
    { operation },
  );
  const second = client.request(query);
  await expect.poll(() => peer.requests.length).toBe(2);
  expect(peer.requests.map(({ socket: _, ...request }) => request)).toMatchObject([
    {
      version: 3,
      id: first.id,
      operation,
      command: { method: 'prompt', prompt: { parts: [{ type: 'text', text: 'hello 世界' }] } },
    },
    { version: 3, id: second.id, command: query },
  ]);
  expect(peer.requests[1].operation).toBeUndefined();
  peer.query(peer.requests[1], 'view', emptyView());
  peer.send(peer.requests[0].socket, {
    type: 'batch',
    batch: { session, revision: 1, view: emptyView(), entries: [], tools: [], removed: false },
  });
  peer.send(peer.requests[0].socket, { type: 'resync_required' });
  const result = await second.result;
  expect(result).toEqual(emptyView());
  peer.reply(peer.requests[0], accepted);
  await first.result;
  expect(events).toHaveLength(1);
  expect(resync).toBe(1);
  expect(observerErrors).toBe(1);
  expect(first.operation).toBe(operation);
});

it('reserves 16 ordinary/4 control/4 query slots and retains abandoned sent quotas', async () => {
  const peer = await fixture(),
    client = peer.client();
  const ordinary = Array.from({ length: 16 }, () =>
    client.request({
      method: 'prompt',
      session,
      prompt: { parts: [{ type: 'text', text: 'held' }] },
    }),
  );
  const control = Array.from({ length: 4 }, () => client.request({ method: 'cancel', session }));
  const queries = Array.from({ length: 4 }, () => client.request(query));
  await expect.poll(() => peer.requests.length).toBe(24);
  for (const command of [
    {
      method: 'prompt' as const,
      session,
      prompt: { parts: [{ type: 'text' as const, text: 'overflow' }] },
    },
    { method: 'cancel' as const, session },
    query,
  ])
    expect(() => client.request(command)).toThrow('pool is full');
  const abandoned = expect(ordinary[0].result).rejects.toMatchObject({
    code: 'abandoned',
    sideEffectPossible: true,
  });
  ordinary[0].abandon();
  await abandoned;
  expect(() =>
    client.request({
      method: 'prompt',
      session,
      prompt: { parts: [{ type: 'text', text: 'still full' }] },
    }),
  ).toThrow('pool is full');
  peer.reply(peer.requests[0], accepted);
  await expect
    .poll(() => {
      try {
        const t = client.request({
          method: 'prompt',
          session,
          prompt: { parts: [{ type: 'text', text: 'replacement' }] },
        });
        t.result.catch(() => {});
        return t.id;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThan(24);
  // Old response IDs cannot consume the replacement's observer.
  peer.reply(peer.requests[0], accepted);
  for (const request of peer.requests.slice(1)) {
    if (request.command.method === 'inspect') peer.query(request, 'view', emptyView());
    else peer.reply(request, accepted);
  }
  await Promise.all([...ordinary.slice(1), ...control, ...queries].map((t) => t.result));
});

it('abandonment before connection sends nothing and does not generate cancellation', async () => {
  const peer = await fixture(),
    client = peer.client();
  const ticket = client.request({
    method: 'fork',
    session,
    request: { entry: entryId.parse('entry') },
  });
  const failed = expect(ticket.result).rejects.toMatchObject({
    operation: ticket.operation,
    sideEffectPossible: false,
  });
  ticket.abandon();
  await failed;
  await pause(30);
  expect(peer.requests).toHaveLength(0);
  const read = client.request(query);
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.query(peer.requests[0], 'view', emptyView());
  await read.result;
  expect(peer.requests[0].command.method).toBe('inspect');
});

it('observer timeout retains its operation and never emits cancel or retries', async () => {
  const peer = await fixture(),
    client = peer.client();
  const ticket = client.request(
    { method: 'prompt', session, prompt: { parts: [{ type: 'text', text: 'slow provider' }] } },
    { timeoutMs: 80 },
  );
  const failed = expect(ticket.result).rejects.toMatchObject({
    code: 'timeout',
    operation: ticket.operation,
    sideEffectPossible: true,
  });
  await expect.poll(() => peer.requests.length).toBe(1);
  await failed;
  peer.reply(peer.requests[0], accepted);
  await pause(20);
  expect(peer.requests).toHaveLength(1);
});

it('disconnect rejects accepted observers and explicit reconnect does not resend/subcribe', async () => {
  const peer = await fixture(),
    client = peer.client();
  const first = client.request({ method: 'create', harness: 'Pi', cwd: '/workspace' });
  const failed = expect(first.result).rejects.toMatchObject({
    code: 'disconnected',
    operation: first.operation,
    sideEffectPossible: true,
  });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.requests[0].socket.destroy();
  await failed;
  await pause(20);
  expect(peer.requests).toHaveLength(1);
  const next = client.request({ method: 'list' });
  await expect.poll(() => peer.requests.length).toBe(2);
  expect(next.id).toBeGreaterThan(first.id);
  expect(peer.requests[1].command.method).toBe('list');
  peer.query(peer.requests[1], 'list', { sessions: [], next_cursor: null });
  await next.result;
});

it.each([
  Buffer.from('{"type":"reply","id":"legacy-string","events":[]}\n'),
  Buffer.from('{"type":"reply","id":9007199254740992,"events":[]}\n'),
  Buffer.from('{"type":"unknown"}\n'),
  Buffer.from([0xff, 10]),
  Buffer.from('\n'),
])('fails closed on malformed or unsupported frames without content echo (%#)', async (frame) => {
  const peer = await fixture(),
    client = peer.client();
  const ticket = client.request(query);
  const failed = expect(ticket.result).rejects.toMatchObject({ code: 'protocol' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.requests[0].socket.write(frame);
  await failed;
});

it('preserves split UTF-8 and does not slide an incomplete-frame deadline', async () => {
  const peer = await fixture(),
    client = peer.client();
  const ticket = client.request(query);
  await expect.poll(() => peer.requests.length).toBe(1);
  const body = Buffer.from(
    JSON.stringify({
      type: 'query',
      id: ticket.id,
      result: { kind: 'view', value: { ...emptyView(), status: { Failed: '😀世界' } } },
    }) + '\n',
  );
  const split = body.indexOf(Buffer.from('😀')) + 2;
  peer.requests[0].socket.write(body.subarray(0, split));
  await pause(10);
  peer.requests[0].socket.write(body.subarray(split));
  expect((await ticket.result).status).toEqual({ Failed: '😀世界' });
  WORKBENCH_LIMITS.partialMs = 50;
  const held = client.request(query),
    failed = expect(held.result).rejects.toMatchObject({ code: 'protocol' });
  await expect.poll(() => peer.requests.length).toBe(2);
  peer.requests[1].socket.write('{');
  const trickle = setInterval(() => peer.requests[1].socket.write(' '), 15);
  try {
    await failed;
  } finally {
    clearInterval(trickle);
  }
});

it('rejects an oversized unfinished frame before parsing', async () => {
  const peer = await fixture(),
    client = peer.client();
  const ticket = client.request(query),
    failed = expect(ticket.result).rejects.toMatchObject({ code: 'protocol' });
  await expect.poll(() => peer.requests.length).toBe(1);
  peer.requests[0].socket.write(Buffer.alloc(WORKBENCH_LIMITS.frameBytes + 1, 32));
  await failed;
});

function asset(mime = 'image/png', size = 24) {
  const bytes = Buffer.alloc(size);
  if (mime === 'image/png') {
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(bytes);
    bytes.write('IHDR', 12);
  } else if (mime === 'image/jpeg') Buffer.from([0xff, 0xd8, 0xff]).copy(bytes);
  else if (mime === 'image/gif') bytes.write('GIF89a');
  else {
    bytes.write('RIFF');
    bytes.write('WEBP', 8);
  }
  const image = imageRef.parse({
    id: 'image',
    mime,
    bytes: size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return { format_version: 1, image, data: bytes.toString('base64') };
}
it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
  'verifies archive response identity/hash/canonical base64/signature for %s',
  async (mime) => {
    const peer = await fixture(),
      client = peer.client(),
      payload = asset(mime);
    const ticket = client.request({ method: 'image', image: payload.image });
    expect(ticket.operation).toBeUndefined();
    await expect.poll(() => peer.requests.length).toBe(1);
    peer.send(peer.requests[0].socket, { type: 'image', id: ticket.id, asset: payload });
    expect(await ticket.result).toEqual(payload);
  },
);

it('roundtrips the 4 MiB signature fixture under the 8 MiB frame (not full image decoding)', async () => {
  const peer = await fixture(),
    client = peer.client(),
    payload = asset('image/png', 4 * 1024 * 1024);
  const tickets = [
    client.request({ method: 'image', image: payload.image }),
    client.request({ method: 'image', image: payload.image }),
  ];
  await expect.poll(() => peer.requests.length).toBe(2);
  for (const ticket of tickets)
    peer.send(peer.requests[0].socket, { type: 'image', id: ticket.id, asset: payload });
  for (const ticket of tickets) expect((await ticket.result).image).toEqual(payload.image);
});

it.each(['hash', 'identity', 'base64', 'signature', 'reply-kind'])(
  'rejects invalid image response: %s',
  async (failure) => {
    const peer = await fixture(),
      client = peer.client(),
      payload = asset();
    if (failure === 'signature') {
      const bytes = Buffer.alloc(24);
      payload.data = bytes.toString('base64');
      payload.image.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const ticket = client.request({ method: 'image', image: payload.image });
    const failed = expect(ticket.result).rejects.toMatchObject({ code: 'protocol' });
    await expect.poll(() => peer.requests.length).toBe(1);
    const wire = structuredClone(payload);
    if (failure === 'hash') wire.data = Buffer.alloc(24).toString('base64');
    if (failure === 'identity') wire.image.id = imageRef.parse({ ...wire.image, id: 'other' }).id;
    if (failure === 'base64') wire.data += '\n';
    peer.send(
      peer.requests[0].socket,
      failure === 'reply-kind'
        ? { type: 'reply', id: ticket.id, events: [] }
        : { type: 'image', id: ticket.id, asset: wire },
    );
    await failed;
  },
);

describe('boundary validation', () => {
  it('rejects paths/URIs, native fork targets, invalid IDs, pixel events and unsafe integers', () => {
    for (const value of [
      { method: 'image', path: '/secret.png' },
      { method: 'image', uri: 'https://example.invalid/no' },
      { method: 'fork', session, request: { entry: 'entry', native_path: '/secret' } },
      { method: 'inspect', session: '../escape' },
    ])
      expect(() => clientCommand.parse(value)).toThrow();
    expect(() =>
      commitBatch.parse({
        session,
        revision: 1,
        entries: [{ text: 'missing entry' }],
        tools: [],
        view: null,
        removed: false,
      }),
    ).toThrow();
    expect(() =>
      commitBatch.parse({
        session,
        revision: 1,
        view: null,
        entries: [],
        tools: [],
        removed: false,
        data: 'pixels',
      }),
    ).toThrow();
    expect(() => commitBatch.parse({ ForkPrepared: {} })).toThrow();
    expect(() =>
      sessionView.parse({ ...emptyView(), revision: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => sessionView.parse({ ...emptyView(), cwd: '/workspace/../elsewhere' })).toThrow();
  });
  it('forbids operation IDs on image/subscription requests before connecting', async () => {
    const peer = await fixture(),
      client = peer.client(),
      operation = operationId.parse('op');
    for (const command of [
      { method: 'image' as const, image: asset().image },
      { method: 'attach' as const, session },
    ])
      expect(() => client.request(command, { operation })).toThrow(WorkbenchError);
    await pause(10);
    expect(peer.sockets.size).toBe(0);
  });
});
