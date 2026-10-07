import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ServiceConfig } from '../src/session-protocol';

/** Real production daemon with an explicitly configured mock ACP worker. */
export async function startRustService(root: string, config: ServiceConfig) {
  const file = join(root, 'sessions.json');
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const command =
    process.env.PI_TEST_SESSION_DAEMON || resolve('rust/target/debug/pi-acp-session-daemon');
  const child = spawn(command, ['--config', file, '--data-dir', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '',
    output = '';
  child.stderr.on('data', (data) => {
    errors = (errors + data).slice(-8000);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off('error', failed);
        child.off('exit', closed);
        child.stdout.off('data', ready);
        error ? reject(error) : resolve();
      };
      const failed = (error: Error) => finish(error);
      const closed = (code: number | null) =>
        finish(new Error(`Rust service exited (${code}): ${errors}`));
      const ready = (data: Buffer) => {
        output += data;
        if (output.includes('service ready')) finish();
      };
      const timer = setTimeout(
        () => finish(new Error(`Rust service startup timeout: ${errors}`)),
        10000,
      );
      child.once('error', failed);
      child.once('exit', closed);
      child.stdout.on('data', ready);
    });
  } catch (error) {
    // Failed spawn has no exit event and no pid.
    if (child.pid) await stop();
    throw error;
  }
  return { socket: join(root, 'service', 'sessions.sock'), child, stop };
}
