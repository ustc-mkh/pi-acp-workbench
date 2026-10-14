import { expect, it, vi } from 'vitest';
import { readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { ConversationStatistics } from '../src/conversation-statistics';
import { ClientOperations } from '../src/conversation-history';
import { initialState } from '../src/state';
import { FilePricePreferences } from '../src/price-preferences';
import * as atomic from '../src/atomic-json';
import { priceFixture } from './support/price-fixture';
import { priceOverrideVersion } from '../src/telemetry';
import type { Memento } from 'vscode';
const price = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 };
function fixture() {
  const values = new Map<string, unknown>();
  const storage: Memento = {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) =>
      (values.has(key) ? structuredClone(values.get(key)) : fallback) as T,
    update: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
  const preferences = priceFixture();
  const make = (memento = storage) =>
    new ConversationStatistics(
      memento,
      new ClientOperations(),
      () => ({ state: initialState(), harness: 'pi', retained: false }),
      () => {},
      () => {},
      new FilePricePreferences(preferences.file),
    );
  return { values, storage, preferences, make };
}
it('rejects stale saves and resets for the same model inside the file lock', async () => {
  const { make } = fixture();
  const a = make(),
    b = make();
  const initial = priceOverrideVersion('p/a', {});
  await a.setPrice('p/a', price, initial);
  await expect(b.setPrice('p/a', { ...price, input: 0 }, initial)).rejects.toThrow('其他窗口');
  await expect(b.setPrice('p/a', undefined, initial)).rejects.toThrow('其他窗口');
  expect(make().value.prices['p/a']).toMatchObject(price);
  // A different model is not spuriously blocked by the first model's save.
  await b.setPrice('p/b', price, priceOverrideVersion('p/b', {}));
  await b.refresh();
  const current = b.value.priceVersions!['p/a'];
  await b.setPrice('p/a', { ...price, input: 7 }, current);
  expect(make().value.prices['p/a'].input).toBe(7);
});
it('permits exactly one concurrent save from an identical model baseline', async () => {
  const { make } = fixture();
  const baseline = priceOverrideVersion('p/a', {});
  const results = await Promise.allSettled([
    make().setPrice('p/a', price, baseline),
    make().setPrice('p/a', { ...price, input: 9 }, baseline),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect([2, 9]).toContain(make().value.prices['p/a'].input);
});
it('retains known global prices on corrupt reads, refuses writes, and recovers after repair', async () => {
  const { make, preferences } = fixture();
  const stats = make();
  await stats.setPrice('p/a', price);
  const saved = await readFile(preferences.file, 'utf8');
  await writeFile(preferences.file, '{broken');
  await stats.refresh();
  expect(stats.value.prices['p/a']).toMatchObject(price);
  expect(stats.value.note).toContain('损坏');
  await expect(stats.setPrice('p/b', price)).rejects.toThrow('损坏');
  expect(await readFile(preferences.file, 'utf8')).toBe('{broken');
  await writeFile(preferences.file, saved);
  await stats.refresh();
  expect(stats.value.prices['p/a']).toMatchObject(price);
  expect(stats.value.note || '').not.toContain('损坏');
});
it('does not silently recreate a known global file after external deletion', async () => {
  const { make, preferences } = fixture();
  const stats = make();
  await stats.setPrice('p/a', price);
  await rm(preferences.file);
  await stats.refresh();
  expect(stats.value.prices['p/a']).toMatchObject(price);
  expect(stats.value.note).toContain('丢失');
  await expect(stats.setPrice('p/b', price)).rejects.toThrow('拒绝重新创建');
  await expect(readFile(preferences.file)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refreshes global overrides from another window without a connected agent', async () => {
  const { make } = fixture();
  const a = make(),
    b = make();
  await a.setPrice('p/a', price);
  await b.refresh();
  expect(b.value.prices['p/a']).toMatchObject(price);
  expect(b.value.priceVersions!['p/a']).toBe(a.value.priceVersions!['p/a']);
  await a.setPrice('p/a');
  await b.refresh();
  expect(b.value.prices['p/a']).toBeUndefined();
  expect(b.value.priceVersions!['p/a']).not.toBe(priceOverrideVersion('p/a', {}));
});
it('never imports workspace fallback values and rejects symlink price files', async () => {
  const { preferences } = fixture();
  expect(preferences.read({ 'old/model': price })).toEqual({});
  await preferences.set('p/a', price, { 'old/model': price });
  expect(preferences.read()).toEqual({ 'p/a': price });
  const alias = `${preferences.file}.alias`;
  await symlink(preferences.file, alias);
  expect(() => new FilePricePreferences(alias).read()).toThrow();
});
it('shares one writer lock through symlinked storage directories', async () => {
  const { preferences } = fixture();
  await preferences.set('seed/model', price);
  const aliasDir = `${dirname(preferences.file)}-alias`;
  await symlink(dirname(preferences.file), aliasDir);
  try {
    const aliased = new FilePricePreferences(join(aliasDir, 'price-overrides.json'));
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        (n % 2 ? preferences : aliased).set(`p/model${n}`, { ...price, input: n }),
      ),
    );
    expect(Object.keys(preferences.read())).toHaveLength(13);
    for (let n = 0; n < 12; n++) expect(preferences.read()[`p/model${n}`]?.input).toBe(n);
  } finally {
    await rm(aliasDir);
  }
});
it('preserves different models written by independently loaded instances', async () => {
  const { make } = fixture();
  const a = make(),
    b = make();
  await a.setPrice('p/a', price);
  await b.setPrice('p/b', price);
  expect(make().value.prices).toMatchObject({ 'p/a': price, 'p/b': price });
  await Promise.all([a.setPrice('q/a', price), b.setPrice('q/b', price)]);
  expect(make().value.prices).toMatchObject({
    'p/a': price,
    'p/b': price,
    'q/a': price,
    'q/b': price,
  });
  await a.setPrice('p/a');
  expect(make().value.prices['p/a']).toBeUndefined();
  expect(make().value.prices['p/b']).toMatchObject(price);
});
it('does not write prices through independent whole-object Memento caches', async () => {
  const { make } = fixture();
  let disk: Record<string, unknown> = { prices: { legacy: price } };
  const load = (): Memento => {
    const local = structuredClone(disk);
    return {
      keys: () => Object.keys(local),
      get: <T>(key: string, fallback?: T) =>
        (Object.hasOwn(local, key) ? local[key] : fallback) as T,
      update: async (key, value) => {
        local[key] = value;
        disk = structuredClone(local);
      },
    };
  };
  const a = make(load()),
    b = make(load());
  await a.setPrice('p/a', price);
  await b.setPrice('p/b', price);
  await Promise.all([a.setPrice('q/a', price), b.setPrice('q/b', price)]);
  expect(make(load()).value.prices.legacy).toBeUndefined();
  expect(make(load()).value.prices).toMatchObject({
    'p/a': price,
    'p/b': price,
    'q/a': price,
    'q/b': price,
  });
  expect(disk).toEqual({ prices: { legacy: price } });
});
it('resets survive restart and stale writers do not resurrect legacy overrides', async () => {
  const { make, storage } = fixture();
  await storage.update('prices', { 'p/a': price, 'q/b': price });
  const a = make(),
    stale = make();
  await a.setPrice('p/a');
  await stale.setPrice('q/c', price);
  expect(make().value.prices['p/a']).toBeUndefined();
  expect(make().value.prices['q/b']).toBeUndefined();
  expect(make().value.prices).toMatchObject({ 'q/c': price });
  await stale.setPrice('p/a', { ...price, input: 7 });
  expect(make().value.prices['p/a'].input).toBe(7);
});
it('loads recorded usage without importing workspace prices or resets', async () => {
  const { make, storage } = fixture();
  await storage.update('prices', { m: price });
  await storage.update('price:openai/m', null);
  await storage.update('usageRecords', [
    {
      id: 'r',
      sessionId: 's',
      model: 'google/m',
      timestamp: 1,
      kind: 'acp-turn',
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ]);
  const stats = make();
  expect(stats.value.records).toHaveLength(1);
  expect(stats.value.prices['google/m']).toBeUndefined();
  expect(stats.value.prices['openai/m']).toBeUndefined();
  await stats.setPrice('unrelated/model', price);
  expect(make().value.prices['google/m']).toBeUndefined();
});
it('does not resurrect reset models while expanding a legacy bare price', async () => {
  const { make, storage } = fixture();
  await storage.update('prices', { m: price });
  await storage.update('price:openai/m', null);
  await storage.update('price:google/m', null);
  const stats = make();
  stats.value.models = [
    { id: 'openai/m', name: 'one' },
    { id: 'google/m', name: 'two' },
  ];
  await stats.setPrice('other/model', price);
  expect(stats.value.prices['openai/m']).toBeUndefined();
  expect(stats.value.prices['google/m']).toBeUndefined();
});
it('failed file writes leave the durable preference and published value intact', async () => {
  const { make } = fixture();
  const stats = make();
  await stats.setPrice('p/a', price);
  const spy = vi.spyOn(atomic, 'writeAtomicJson').mockRejectedValueOnce(new Error('disk failure'));
  await expect(stats.setPrice('p/a', { ...price, input: 9 })).rejects.toThrow('disk failure');
  expect(make().value.prices['p/a'].input).toBe(2);
  expect(stats.value.prices['p/a'].input).toBe(2);
  spy.mockRestore();
});
it('rejects corrupt files without falling back to stale Memento data or overwriting evidence', async () => {
  const { preferences } = fixture();
  await preferences.set('p/a', price, {});
  await writeFile(preferences.file, 'broken');
  expect(() => preferences.read({ 'p/a': price })).toThrow();
  await expect(preferences.set('p/b', price, {})).rejects.toThrow();
  expect(await readFile(preferences.file, 'utf8')).toBe('broken');
});
it('rejects oversized files and invalid models without replacing the file', async () => {
  const { preferences } = fixture();
  await preferences.set('p/a', price, {});
  const saved = await readFile(preferences.file, 'utf8');
  await expect(preferences.set('bad\nmodel', price, {})).rejects.toThrow();
  expect(await readFile(preferences.file, 'utf8')).toBe(saved);
  await writeFile(preferences.file, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  expect(() => preferences.read({})).toThrow('过大');
  await expect(preferences.set('p/b', price, {})).rejects.toThrow('过大');
  expect((await readFile(preferences.file)).length).toBe(4 * 1024 * 1024 + 1);
});
it('serializes actual child-process writers with independent caches', async () => {
  const { preferences } = fixture();
  await preferences.set('p/seed', price, {});
  const bundle = join(dirname(preferences.file), 'price-store.cjs');
  await build({
    entryPoints: [resolve('src/price-preferences.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const run = (prefix: string) =>
    new Promise<void>((pass, fail) => {
      const script = `const {FilePricePreferences}=require(${JSON.stringify(bundle)});
      const store=new FilePricePreferences(${JSON.stringify(preferences.file)});
      (async()=>{for(let i=0;i<10;i++) await store.set(${JSON.stringify(prefix)}+i,${JSON.stringify(price)},{});})()
        .catch(e=>{console.error(e);process.exitCode=1;});`;
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
  await Promise.all([run('p/a'), run('p/b')]);
  const data = preferences.read({});
  expect(Object.keys(data)).toHaveLength(21);
  for (let i = 0; i < 10; i++) {
    expect(data[`p/a${i}`]).toEqual(price);
    expect(data[`p/b${i}`]).toEqual(price);
  }
}, 15000);
