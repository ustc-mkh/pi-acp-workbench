#!/usr/bin/env node
// Export native-branch fixtures for cross-implementation verification (docs/data-formats.md §8).
// Bundles src/native-branch.ts, runs the same entry sequences as test/native-branch.test.ts,
// and writes test/fixtures/native-branch/*.json with expected hashes/bindings that a Rust
// implementation must reproduce byte-for-byte. Re-run after intentional algorithm changes.
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const stage = await mkdtemp(join(tmpdir(), 'pi-fixture-'));
const out = resolve('test/fixtures/native-branch');
try {
  const bundle = join(stage, 'native-branch.cjs');
  await build({ entryPoints: ['src/native-branch.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
  const { nativeForkPoints, nativePrefixHash, nativeTextKey, bindNativeForks } = createRequire(import.meta.url)(bundle);

  const chain = items => items.map((e, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, ...e }));
  const msg = (role, text, timestamp = 1) => ({ message: { role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' } });

  const cases = [];
  const pointsCase = (name, description, entries, expectError) => cases.push({ name, kind: 'points', description, entries, expected: expectError ? { error: expectError } : { forkPoints: nativeForkPoints(entries), prefixHash: nativePrefixHash(entries) } });
  const bindCase = (name, description, entries, uiEntries, previous) => cases.push({ name, kind: 'bind', description, entries, uiEntries, previous, expected: { bound: bindNativeForks(uiEntries, nativeForkPoints(entries), previous) } });

  pointsCase('compaction-boundary', 'prefix hash preserves prior but not later compactions',
    chain([msg('user', 'before'), msg('assistant', 'answer'), { type: 'compaction', summary: 'native summary', firstKeptEntryId: '1', tokensBefore: 100 }, msg('user', 'after'), msg('assistant', 'latest')]));

  pointsCase('tool-pairing', 'cuts are safe only where tool calls and results are paired',
    chain([msg('user', 'task'), { message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'toolCall', id: 't1' }, { type: 'toolCall', id: 't2' }] } }, { message: { role: 'toolResult', toolCallId: 't1', content: [] } }, msg('assistant', 'partial'), { message: { role: 'toolResult', toolCallId: 't2', content: [] } }, msg('assistant', 'done')]));

  pointsCase('orphaned-result', 'an unmatched tool result is never a safe cut',
    chain([{ message: { role: 'toolResult', toolCallId: 'unknown', content: [] } }, msg('assistant', 'not safe')]));

  pointsCase('error-and-context-edit', 'error responses and omitted attempts are excluded',
    chain([{ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'bad' }], stopReason: 'error' } }, { type: 'context_edit', targetId: '0', replacement: null }, msg('user', 'retry'), msg('assistant', 'ok')]));

  pointsCase('label-rechaining', 'labels are UI metadata and never change the context fingerprint',
    chain([msg('user', 'a'), { type: 'label', targetId: '0', label: 'bookmark' }, msg('assistant', 'b'), { type: 'compaction', firstKeptEntryId: '1', summary: 'summary' }, msg('assistant', 'c')]));

  pointsCase('invalid-compaction-boundary', 'a compaction pointing past itself or nowhere fails closed',
    chain([msg('user', 'x'), { type: 'compaction', summary: 's', firstKeptEntryId: 'missing' }]), '原生压缩边界无效');

  bindCase('duplicate-text-timestamp', 'ambiguous rows fail closed; messageId timestamps disambiguate',
    chain([msg('assistant', 'same', 10), msg('assistant', 'same', 20)]),
    [{ id: 'a', role: 'assistant', text: 'same' }, { id: 'b', role: 'assistant', text: 'same' }].map((r, i) => ({ ...r, messageId: String((i + 1) * 10) })));

  bindCase('duplicate-text-previous', 'previously verified mappings survive ambiguity',
    chain([msg('assistant', 'same', 10), msg('assistant', 'same', 20)]),
    [{ id: 'a', role: 'assistant', text: 'same' }, { id: 'b', role: 'assistant', text: 'same' }],
    { a: { entryId: '0', hash: '__from_points__' } });

  // JS JSON.stringify orders integer-index keys ('0','1',…) numerically
  // BEFORE insertion-ordered string keys — a Rust serializer that only keeps
  // document order (preserve_order) would produce a different hash here.
  pointsCase('numeric-keys', 'integer-index object keys sort first in JSON.stringify',
    chain([msg('user', 'numeric'), { message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], extra: { '10': 'a', '2': 'b', z: 'c', '0': 'd' } }, timestamp: 2, stopReason: 'stop' }]));

  bindCase('embedded-context-image', 'embedded context and images match native text without re-encoding',
    chain([{ message: { role: 'user', content: [{ type: 'text', text: 'look\n[Embedded Context] file:///a (text/plain)\ncode' }, { type: 'image', data: 'native-resized-image' }], timestamp: 1 } }]),
    [{ id: 'user', role: 'user', text: 'look 📎a', contextBlocks: [
      { type: 'text', text: 'look' },
      { type: 'resource', resource: { uri: 'file:///a', mimeType: 'text/plain', text: 'code' } },
      { type: 'image', mimeType: 'image/png', data: 'original-image' },
    ]}]);

  await mkdir(out, { recursive: true });
  for (const c of cases) {
    if (c.previous?.__from_points__) {
      // Fill the previous-hash slot with the computed point hash for entry 0.
      const points = nativeForkPoints(c.entries);
      c.previous = { a: { entryId: '0', hash: points[0].hash } };
      c.expected = { bound: bindNativeForks(c.uiEntries, points, c.previous) };
    }
    await writeFile(join(out, `${c.name}.json`), JSON.stringify(c, null, 2) + '\n');
    console.log(`wrote test/fixtures/native-branch/${c.name}.json`);
  }
} finally { await rm(stage, { recursive: true, force: true }); }
