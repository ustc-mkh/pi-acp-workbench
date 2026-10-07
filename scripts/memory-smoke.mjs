import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'pi-memory-build-'));
try {
  const file = join(directory, 'memory.mjs');
  await build({
    entryPoints: ['test/memory-soak.ts'],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
    },
  });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(directory, { recursive: true, force: true });
}
