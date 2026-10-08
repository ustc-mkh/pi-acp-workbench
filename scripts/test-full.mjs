#!/usr/bin/env node
// Compile once, then run independent suites with bounded process-level overlap.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { availableParallelism } from 'node:os';
import { finished } from 'node:stream/promises';
import { testPool } from './lib/test-pool.mjs';
import { pruneTestReports, reportRetention } from './lib/test-reports.mjs';
const keep = reportRetention(process.env.TEST_KEEP_RUNS);
const jobs = Number(process.env.TEST_JOBS || Math.min(3, availableParallelism()));
// Validate before doing expensive preparation.
await testPool([], jobs);
await mkdir('.test-results', { recursive: true });
// Publish only after marking active so a concurrent pruner cannot delete a new run.
const stagedReport = await mkdtemp(resolve('.test-results/.run-'));
await writeFile(resolve(stagedReport, '.active'), String(process.pid), { mode: 0o600 });
const report = resolve('.test-results', basename(stagedReport).slice(1));
await rename(stagedReport, report);
try {
  await pruneTestReports(resolve('.test-results'), keep);
  await runTests();
} finally {
  await rm(resolve(report, '.active'), { force: true });
  await pruneTestReports(resolve('.test-results'), keep);
}
async function runTests() {
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  function command(name, program, args) {
    return {
      name,
      run: async () => {
        if (abort.signal.aborted) throw new Error('Test run interrupted');
        const file = resolve(report, name + '.log'),
          log = createWriteStream(file, { mode: 0o600 });
        const flushed = finished(log);
        void flushed.catch(() => {});
        console.log(`[start] ${name}`);
        const child = spawn(program, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        const kill = (signal) => {
          if (!child.pid) return;
          try {
            process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
          } catch (e) {
            if (e.code !== 'ESRCH') throw e;
          }
        };
        let timer;
        const stop = () => {
          kill('SIGTERM');
          timer = setTimeout(() => kill('SIGKILL'), 5000);
          timer.unref();
        };
        abort.signal.addEventListener('abort', stop, { once: true });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        const done = new Promise((res, rej) => {
          child.once('error', rej);
          child.once('close', (code, signal) =>
            code === 0 ? res() : rej(new Error(`${name} exited ${code ?? signal}; log: ${file}`)),
          );
        });
        log.on('error', () => {
          kill('SIGTERM');
        });
        try {
          await done;
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', stop);
          log.end();
          await flushed;
        }
      },
    };
  }
  const node = (name, ...args) => command(name, process.execPath, args);
  const cargo = (name, ...args) =>
    command(name, 'cargo', [...args, '--manifest-path', 'rust/Cargo.toml']);
  const started = performance.now();
  console.log(`Test logs: ${report}; TEST_JOBS=${jobs}`);
  const prep = await testPool(
    [
      node('typecheck', 'node_modules/typescript/bin/tsc', '--noEmit'),
      cargo('build-debug', 'build', '--workspace'),
      cargo(
        'build-contract',
        'build',
        '--features',
        'pi-acp-telegram-daemon/contract-test',
        '--target-dir',
        'rust/target/contract',
      ),
    ],
    jobs,
  );
  if (prep.some((r) => !r.ok)) {
    for (const r of prep) if (!r.ok) console.error(r.error);
    process.exitCode = 1;
  } else {
    const suites = [
      node('protocol-types', 'scripts/generate-service-types.mjs', '--check'),
      node(
        'typescript',
        'node_modules/vitest/vitest.mjs',
        'run',
        '--maxWorkers',
        String(Math.min(4, availableParallelism())),
      ),
      cargo('rust-unit', 'test'),
      node('service-contract', 'scripts/service-contract.mjs'),
      node('telegram-contract', 'scripts/telegram-contract.mjs'),
      node('rust-integration', 'scripts/rust-integration.mjs'),
      node('rust-memory', 'scripts/memory-smoke.mjs'),
      node(
        'runner-unit',
        '--test',
        'scripts/test-pool.test.mjs',
        'scripts/test-reports.test.mjs',
        'scripts/telegram-setup.test.mjs',
      ),
    ];
    const results = await testPool(suites, jobs);
    for (const r of results) {
      console.log(`[${r.ok ? 'pass' : 'FAIL'}] ${r.name} ${(r.ms / 1000).toFixed(1)}s`);
      if (!r.ok) console.error(r.error);
    }
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  }
  if (abort.signal.aborted) process.exitCode = 130;
  console.log(`Total ${((performance.now() - started) / 1000).toFixed(1)}s; logs: ${report}`);
}
