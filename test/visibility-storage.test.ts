import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { FileVisibilityPreferences } from '../src/visibility-preferences';
import * as atomic from '../src/atomic-json';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-visibility-'));
  roots.push(root);
  return new FileVisibilityPreferences(join(root, 'visibility.json'));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('merges independent windows, harnesses and targeted changes', async () => {
  const a = fixture(),
    b = new FileVisibilityPreferences(a.file);
  await Promise.all([a.set('pi', ['a', 'b'], ['a'], [], {}), b.set('codex', ['c'], ['c'], [], {})]);
  await b.set('pi', ['a', 'b'], ['b'], [], {});
  expect(a.read({})).toEqual({ pi: { hidden: ['a', 'b'] }, codex: { hidden: ['c'] } });
  await a.set('pi', ['a', 'b'], ['a'], ['a'], {});
  expect(b.read({}).pi).toEqual({ hidden: ['b'] });
});
it('does not hide newly discovered models or lose temporarily absent hidden models', async () => {
  const store = fixture();
  await store.set('pi', ['old', 'new'], ['old'], [], {});
  expect(store.read({}).pi).toEqual({ hidden: ['old'] });
  await store.set('pi', ['new'], ['new'], [], {});
  expect(new FileVisibilityPreferences(store.file).read({}).pi).toEqual({ hidden: ['old', 'new'] });
});
it('migrates legacy preferences only once and reset survives stale caches', async () => {
  const store = fixture();
  const legacy = { pi: ['a'], codex: { hidden: ['c'] } };
  expect(store.read(legacy)).toEqual(legacy);
  await store.set('pi', ['a', 'b'], ['a'], ['a'], legacy);
  expect(store.read({})).toEqual({ pi: { hidden: ['b'] }, codex: { hidden: ['c'] } });
  await store.set('pi', ['a', 'b'], [], null, legacy);
  await store.set('claude', ['d'], ['d'], [], legacy);
  expect(store.read(legacy).pi).toEqual({ hidden: [] });
});
it('rejects corrupt, oversized and invalid input without replacing the file', async () => {
  const store = fixture();
  await store.set('pi', ['a'], ['a'], [], {});
  const saved = readFileSync(store.file, 'utf8');
  await expect(store.set('pi', ['a'], ['bad\nmodel'], [], {})).rejects.toThrow();
  expect(readFileSync(store.file, 'utf8')).toBe(saved);
  writeFileSync(store.file, 'broken');
  await expect(store.set('pi', ['a'], ['a'], ['a'], {})).rejects.toThrow('损坏');
  expect(readFileSync(store.file, 'utf8')).toBe('broken');
  writeFileSync(store.file, Buffer.alloc(4 * 1024 * 1024 + 1));
  expect(() => store.read({})).toThrow('过大');
});
it('failed atomic writes leave the last committed visibility intact', async () => {
  const store = fixture();
  await store.set('pi', ['a'], ['a'], [], {});
  vi.spyOn(atomic, 'writeAtomicJson').mockRejectedValueOnce(new Error('disk failure'));
  await expect(store.set('pi', ['a'], ['a'], ['a'], {})).rejects.toThrow('disk failure');
  expect(store.read({}).pi).toEqual({ hidden: ['a'] });
});
it('merges real child-process writers with stale independent legacy caches', async () => {
  const store = fixture();
  const bundle = join(dirname(store.file), 'visibility-store.cjs');
  await build({
    entryPoints: [resolve('src/visibility-preferences.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const run = (prefix: string) =>
    new Promise<void>((pass, fail) => {
      const script = `const {FileVisibilityPreferences}=require(${JSON.stringify(bundle)});
      const store=new FileVisibilityPreferences(${JSON.stringify(store.file)});
      (async()=>{for(let i=0;i<10;i++){const id=${JSON.stringify(prefix)}+i;await store.set('pi',[id],[id],[],{});}})().catch(e=>{console.error(e);process.exitCode=1;});`;
      const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', (b) => {
        errors += b;
      });
      child.on('error', fail);
      child.on('exit', (code) => (code === 0 ? pass() : fail(new Error(errors))));
    });
  await Promise.all([run('a'), run('b')]);
  const saved = store.read({}).pi;
  expect(saved && !Array.isArray(saved) && saved.hidden).toHaveLength(20);
}, 15000);
