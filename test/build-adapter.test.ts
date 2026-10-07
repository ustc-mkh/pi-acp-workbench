import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

it('fails closed for missing or duplicate upstream patch targets', () => {
  expect(() =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import assert from 'node:assert/strict';
    import {replaceExactlyOnce} from './scripts/build-adapter.mjs';
    assert.equal(replaceExactlyOnce('before target after','target','replacement'),'before replacement after');
    assert.throws(()=>replaceExactlyOnce('missing','target','x'), /integration seam changed/);
    assert.throws(()=>replaceExactlyOnce('target target','target','x'), /integration seam changed/);
  `,
      ],
      { stdio: 'pipe' },
    ),
  ).not.toThrow();
});

it('preserves every native registry entry across concurrent adapter processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-registry-'));
  try {
    const worker = join(root, 'writer.cjs'),
      file = join(root, 'session-map.json');
    await build({
      stdin: {
        contents: `import {mutateAdapterStore} from ${JSON.stringify(resolve('src/adapter-store.ts'))};
      const [file,prefix]=process.argv.slice(2);
      for(let i=0;i<20;i++)mutateAdapterStore(file,db=>{db.sessions[prefix+i]={sessionId:prefix+i};});`,
        resolveDir: process.cwd(),
      },
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(
        (prefix) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [worker, file, prefix], { stdio: 'pipe' });
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += chunk;
            });
            child.stdout.resume();
            child.on('error', reject);
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)),
            );
          }),
      ),
    );
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).sessions)).toHaveLength(80);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
