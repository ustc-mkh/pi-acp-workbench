import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchClient } from '../../src/workbench-client';
import {
  clientCommand,
  sessionView,
  type ClientCommand,
  type OperationId,
} from '../../src/workbench-protocol';

export interface PeerRequest {
  version: number;
  id: number;
  operation?: OperationId;
  command: ClientCommand;
  socket: Socket;
}
export async function workbenchPeer() {
  const root = await mkdtemp(join(tmpdir(), 'wb-client-'));
  const requests: PeerRequest[] = [],
    sockets = new Set<Socket>();
  const clients: WorkbenchClient[] = [],
    cleanups: (() => Promise<void>)[] = [];
  const send = (socket: Socket, value: unknown) => socket.write(JSON.stringify(value) + '\n');
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const raw = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const request = { ...raw, command: clientCommand.parse(raw.command), socket };
        requests.push(request);
        if (request.command.method === 'detach')
          send(socket, { type: 'detached', id: request.id, session: request.command.session });
      }
    });
  });
  const path = join(root, 'workbench.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    path,
    requests,
    sockets,
    cleanups,
    client() {
      const client = new WorkbenchClient(path);
      clients.push(client);
      return client;
    },
    reply(request: PeerRequest, receipt: unknown) {
      send(request.socket, { type: 'reply', id: request.id, receipt });
    },
    query(request: PeerRequest, kind: string, value: unknown) {
      send(request.socket, { type: 'query', id: request.id, result: { kind, value } });
    },
    send,
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
      clients.forEach((client) => client.dispose());
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function emptyView(revision = 1) {
  return sessionView.parse({
    id: 'session',
    provider_session: null,
    harness: 'Pi',
    cwd: '/workspace',
    status: 'Idle',
    last_entry_seq: 0,
    origin: null,
    configuration_intent: null,
    plan: { items: [] },
    active_turn: null,
    pending_interactions: {},
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_micros: 0,
      context_used: null,
      context_size: null,
    },
    config: { model: null, mode: null },
    catalogue: { models: [], modes: [], commands: [] },
    revision,
  });
}
