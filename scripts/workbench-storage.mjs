#!/usr/bin/env node
// A thin launcher, not a second storage reader/GC implementation. The same
// single production binary owns the flock and typed maintenance transactions.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const binary =
  process.env.WORKBENCH_STORAGE_BINARY || resolve('rust/target/debug/pi-acp-workbenchd');
const child = spawn(binary, ['storage', ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => {
  console.error(
    'Cannot start workbench storage utility; build the daemon or set WORKBENCH_STORAGE_BINARY',
  );
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
