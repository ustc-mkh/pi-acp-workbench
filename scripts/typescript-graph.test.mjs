import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { typescriptGraph } from './lib/typescript-graph.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-type-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

test('finds erased import/export types, inline import types and dynamic imports without executing source', async (t) => {
  const root = await fixture(t, {
    'view.ts': `import type { State } from './channel';
      export type { Item } from './row';
      type Old = import('./old-state').Old;
      const load = () => import('./dynamic');
      throw new Error('never execute');`,
    'channel.ts': `export type { State } from './old-state';`,
    'row.ts': 'export interface Item {}',
    'old-state.ts': 'export interface State {}; export interface Old {}',
    'dynamic.ts': 'throw new Error("never execute");',
  });
  const graph = await typescriptGraph(root, ['view.ts']);
  assert.deepEqual([...graph.keys()].sort(), [
    'channel.ts',
    'dynamic.ts',
    'old-state.ts',
    'row.ts',
    'view.ts',
  ]);
  // A runtime-only allowlist would miss old-state.ts; the source graph must reject it.
  assert.throws(() => {
    for (const path of graph.keys()) assert(!path.includes('old-state'), 'legacy state type');
  }, /legacy state type/);
});

test('follows compiler path aliases inherited through an extended configuration', async (t) => {
  const root = await fixture(t, {
    'tsconfig.json': '{"extends":"./base.json"}',
    'base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@old/*":["legacy/*"]}}}',
    'view.ts': "import type { State } from '@old/state';",
    'legacy/state.ts': 'export interface State {}',
  });
  assert.deepEqual([...(await typescriptGraph(root, ['view.ts'])).keys()].sort(), [
    'legacy/state.ts',
    'view.ts',
  ]);
});

test('fails on unresolved local imports rather than silently dropping the type edge', async (t) => {
  const root = await fixture(t, { 'view.ts': "type T = import('./missing').T;" });
  await assert.rejects(typescriptGraph(root, ['view.ts']), /unresolved local TypeScript import/);
});

test('retains third-party type specifiers so frontend audits can reject raw ACP coupling', async (t) => {
  const root = await fixture(t, {
    'view.ts': "import type { ContentBlock } from '@agentclientprotocol/sdk';",
  });
  const graph = await typescriptGraph(root, ['view.ts']);
  assert.deepEqual(graph.get('view.ts').imports, ['@agentclientprotocol/sdk']);
});

test('joins cycles once and refuses malformed compiler configuration', async (t) => {
  const root = await fixture(t, {
    'a.ts': "import type { B } from './b'; export interface A {}",
    'b.ts': "import type { A } from './a'; export interface B {}",
  });
  assert.equal((await typescriptGraph(root, ['a.ts'])).size, 2);
  await writeFile(join(root, 'tsconfig.json'), '{ broken');
  await assert.rejects(
    typescriptGraph(root, ['a.ts']),
    /invalid TypeScript compiler configuration/,
  );
});
