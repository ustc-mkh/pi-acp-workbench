// Read-only cutover tripwires. This is a static/import audit, not proof of live
// provider compatibility or a substitute for runtime/soak/artifact tests.
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { typescriptGraph } from './lib/typescript-graph.mjs';
import { verifyReleaseSources, verifyReleaseDocuments } from './lib/release-contract.mjs';
await verifyReleaseSources();
await verifyReleaseDocuments();

const text = (path) => readFile(path, 'utf8');
const absent = [
  'rust/crates/pi-acp-session-daemon',
  'rust/crates/pi-acp-telegram-daemon',
  'rust/crates/pi-acp-core/src/protocol.rs',
  'rust/crates/pi-acp-core/src/wire.rs',
  'src/extension.ts',
  'src/remote-agent.ts',
  'src/session-wire.ts',
  'src/session-protocol.generated.ts',
  'src/session-protocol.ts',
  'src/service-state-stream.ts',
  'webview/main.ts',
  'examples/pi-sessions.service',
  'examples/pi-telegram.service',
  'scripts/setup-telegram.mjs',
  'scripts/generate-service-types.mjs',
  'scripts/service-contract.mjs',
  'scripts/telegram-contract.mjs',
  'scripts/browser-smoke.mjs',
  'scripts/preview-components.mjs',
  'scripts/export-fixtures.mjs',
  'rust/crates/pi-acp-workbenchd/src/persistence/history.rs',
  'rust/crates/pi-acp-workbenchd/src/persistence/io.rs',
  ...[
    'client-settings',
    'context',
    'conversation-history',
    'demo',
    'harness',
    'images',
    'local-preferences',
    'model-provider',
    'output-image',
    'price-preferences',
    'session-numbers',
    'session-settings',
    'shared',
    'state-channel',
    'state',
    'transcript-window',
    'turn-diff',
    'ui-dispatch',
    'ui-message-schema',
    'usage-storage',
    'visibility-preferences',
    'workspace-documents',
  ].map((name) => `src/${name}.ts`),
  ...[
    'extension-question',
    'history-paging',
    'history',
    'image-paste',
    'message-actions',
    'messages',
    'models',
    'output-images',
    'prices',
    'selectors',
    'slash-commands',
    'state-inbox',
    'statistics',
    'todo-panel',
    'transcript',
    'usage-chart',
    'usage',
  ].map((name) => `webview/${name}.ts`),
  'webview/style.css',
  ...['history', 'price', 'snapshot'].map((name) => `test/support/${name}-fixture.ts`),
];
for (const path of absent) {
  await access(path).then(
    () => assert.fail(`legacy production path exists: ${path}`),
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
}
const workspace = await text('rust/Cargo.toml');
assert(!/pi-acp-(session|telegram)-daemon/.test(workspace), 'legacy workspace member');
const packageJson = JSON.parse(await text('package.json'));
assert.equal(packageJson.main, './dist/extension.cjs');
assert.equal(
  new Set(Object.values(packageJson.scripts)).size,
  Object.keys(packageJson.scripts).length,
  'duplicate npm aliases',
);
for (const retired of [
  'build:service:test',
  'test:all',
  'test:contract',
  'test:contract:telegram',
  'test:integration:rust',
  'workbenchd',
  'check:protocol',
])
  assert(!Object.hasOwn(packageJson.scripts, retired), `retired script alias: ${retired}`);
assert.deepEqual(Object.keys(packageJson.contributes.configuration.properties), [
  'piAcp.workbenchSocket',
]);
const extension = await text('src/workbench-extension.ts');
for (const { command } of packageJson.contributes.commands)
  assert(
    extension.includes(`command('${command}'`),
    `unimplemented contributed command: ${command}`,
  );

const sourceRoot = 'rust/crates/pi-acp-workbenchd/src';
// Raw JSON may exist only in these four ACP codec/opaque conversion boundaries.
// Include actor/app/worker/transport files, not just the three domain directories.
const jsonBoundaries = new Set(
  ['acp.rs', 'acp/codec.rs', 'acp/content.rs', 'acp/client.rs'].map(
    (path) => `${sourceRoot}/${path}`,
  ),
);
async function business(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await business(path);
    else if (entry.name.endsWith('.rs') && !/(?:^|_)tests\.rs$/.test(entry.name)) {
      const source = await text(path);
      assert(
        !/\b(?:HistoryStore|HistorySnapshot|delivery_events|project_outbox|commit_state|save_image)\b/.test(
          source,
        ),
        `retired file-storage/commit path in ${path}`,
      );
      if (jsonBoundaries.has(path)) continue;
      assert(
        !/\bValue\b|serde_json::(?:json!|from_value|to_value)/.test(source),
        `business raw JSON in ${path}`,
      );
    }
  }
}
await business(sourceRoot);
for (const [file, name] of [
  ['session', 'SessionStore'],
  ['journal', 'JournalStore'],
  ['payload', 'PayloadStore'],
  ['outbox', 'OutboxStore'],
  ['inbox', 'TelegramStore'],
  ['telegram_effect', 'TelegramEffects'],
]) {
  const source = await text(`${sourceRoot}/persistence/${file}.rs`);
  const fields = source.match(new RegExp(`struct ${name} \\{([^}]+)\\}`))?.[1];
  assert(fields?.includes('database: Database'), `${name} must share Database`);
  assert(!/\b(?:root|path|gate)\s*:|Mutex/.test(fields), `file-storage facade in ${name}`);
}

// Inspect the actual esbuild import graphs, without replacing build outputs.
const allowed = {
  extension: /^src\/workbench-[^/]+\.ts$/,
  browser:
    /^(?:src\/workbench-[^/]+|webview\/(?:workbench-main|workbench-management|workbench-drafts|workbench-preferences|workbench-attachment-drafts|markdown|diagrams))\.ts$/,
  adapter: /^src\/(?:pi-[^/]+|adapter-[^/]+|atomic-json|native-branch|telemetry)\.ts$/,
};
for (const [kind, entry] of [
  ['extension', 'src/workbench-extension.ts'],
  ['browser', 'webview/workbench-main.ts'],
]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: kind === 'extension' ? 'node' : 'browser',
    external: ['vscode'],
    logLevel: 'silent',
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    if (path.startsWith('src/') || path.startsWith('webview/'))
      assert(allowed[kind].test(path), `unexpected production ${kind} dependency: ${path}`);
  }
}
// Esbuild erases import type/inline import types. Audit the source graph too,
// including aliases from tsconfig, and keep the provider/SDK boundary out of UI types.
const adapterEntries = [
  ...new Set(
    [...(await text('scripts/build-adapter.mjs')).matchAll(/['"](src\/[^'"]+\.ts)['"]/g)].map(
      (match) => match[1],
    ),
  ),
];
assert(adapterEntries.length > 0, 'adapter source entrypoints not found');
for (const [kind, entries] of [
  ['extension', ['src/workbench-extension.ts']],
  ['browser', ['webview/workbench-main.ts']],
  ['adapter', adapterEntries],
]) {
  const graph = await typescriptGraph('.', entries);
  for (const [path, { source, imports }] of graph) {
    assert(allowed[kind].test(path), `unexpected ${kind} source/type dependency: ${path}`);
    assert(
      !/\bbindNativeForks\b|\bNativeBranchTarget\b|data-image-source/.test(source),
      `legacy display authority in ${path}`,
    );
    if (kind !== 'adapter')
      assert(
        !imports.some((specifier) => specifier.startsWith('@agentclientprotocol/')),
        `raw ACP frontend type: ${path}`,
      );
  }
  console.log(`PASS ${kind} source/type graph: ${graph.size} files`);
}
const documents = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/persistence-recovery.md',
  'test/fixtures/README.md',
  'test/fixtures/rewrite/README.md',
  ...(await readdir('docs'))
    .filter((name) => /^workbench-.*\.md$/.test(name))
    .map((name) => `docs/${name}`),
];
for (const document of documents) {
  for (const [, target] of (await text(document)).matchAll(/\]\(([^)\s]+)/g)) {
    if (target.includes(':') || target.startsWith('#')) continue;
    const path = target.split('#')[0];
    if (path) await access(resolve(dirname(document), path));
  }
}
console.log(
  'PASS workbench cutover audit: legacy paths absent, business JSON scan, contributed commands/config, production runtime/type import graphs and current documentation links',
);
