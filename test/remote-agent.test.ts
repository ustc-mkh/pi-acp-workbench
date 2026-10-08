import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteAgent } from '../src/remote-agent';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it.each([undefined, 1, 2])(
  'rejects service version %s instead of falling back to local writes',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-protocol-version-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socket = join(root, 'service.sock'),
      methods: string[] = [];
    const server = createServer((connection) => {
      let buffer = '';
      connection.on('data', (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        methods.push(request.method);
        connection.write(
          JSON.stringify({
            id: request.id,
            value: {
              protocolVersion: 1,
              agentCapabilities: {
                _meta: {
                  'session-service': { version },
                  'pi-workbench': { version: 2, history: true },
                },
              },
            },
          }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const agent = new RemoteAgent(
      { cwd: root, harness: 'codex', closed: () => {} },
      () => {},
      socket,
    );
    cleanup.push(() => agent.dispose());
    await expect(agent.initialize()).rejects.toThrow('v3');
    expect(methods).toEqual(['hello']);
  },
);
