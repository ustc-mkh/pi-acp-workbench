import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionClient, SessionServer } from '../src/session-wire';

const controls = vi.hoisted(() => ({ beforeChmod: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      await controls.beforeChmod(...args);
      return actual.chmod(...args);
    },
  };
});
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  controls.beforeChmod.mockReset();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it('publishes only after chmod, even in a permissive parent, without changing umask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-private-socket-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o777);
  const path = join(root, 'sessions.sock'),
    umask = process.umask();
  let release!: () => void, entered!: (path: string) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stagedPath = new Promise<string>((resolve) => {
    entered = resolve;
  });
  controls.beforeChmod.mockImplementation(async (path: string) => {
    entered(path);
    await gate;
  });
  const server = new SessionServer(path, async () => 'ok');
  cleanup.push(() => server.dispose());
  const listening = server.listen();
  try {
    const staged = await stagedPath;
    expect((await stat(join(staged, '..'))).mode & 0o777).toBe(0o700);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error('socket published before chmod'));
      });
      socket.once('error', (error) => {
        try {
          expect(error).toMatchObject({ code: 'ENOENT' });
          resolve();
        } catch (failure) {
          reject(failure);
        }
      });
    });
  } finally {
    release();
    await listening;
  }
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(root)).toEqual(['sessions.sock']);
  expect(process.umask()).toBe(umask);
  const client = new SessionClient(path);
  cleanup.push(() => client.dispose());
  expect(await client.call('hello')).toBe('ok');
});

it('cleans the bound listener and private directory if chmod fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-private-socket-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sessions.sock');
  controls.beforeChmod.mockRejectedValueOnce(new Error('chmod failed'));
  const server = new SessionServer(path, async () => 'ok');
  cleanup.push(() => server.dispose());
  await expect(server.listen()).rejects.toThrow('chmod failed');
  expect(await readdir(root)).toEqual([]);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
