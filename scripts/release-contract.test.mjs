import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verifyReleaseDocuments,
  verifyReleaseSources,
  releaseDocuments,
} from './lib/release-contract.mjs';
import { extensionHostBlocker, extensionHostConfig } from './workbench-extension-host.mjs';
test('Rust/TS/build contract is one current cutover and packaged documents have no dangling local links', async () => {
  await verifyReleaseSources();
  await verifyReleaseDocuments();
  assert(releaseDocuments.includes('workbench-cutover.md'));
  assert(releaseDocuments.includes('turn-diff.md'));
  assert(releaseDocuments.includes('workbench-management.md'));
  assert(releaseDocuments.includes('workbench-next-rewrite-plan.md'));
  assert(releaseDocuments.includes('persistence-recovery.md'));
  assert(
    !releaseDocuments.some((file) => /checkpoint|execution|verification|follow-up/.test(file)),
  );
});
test('packaging refuses an operator path or missing documentation rather than copying arbitrary files', async () => {
  for (const target of ['private-config.json', '../business-root/secret', '/etc/passwd'])
    await assert.rejects(
      verifyReleaseDocuments(async () => `[link](${target})`),
      /unpackaged documentation link/,
    );
  await assert.rejects(
    verifyReleaseDocuments(async () => {
      throw new Error('missing document');
    }),
    /missing document/,
  );
});
test('Extension Host fixture includes all required daemon configuration sections', () => {
  const config = extensionHostConfig('/tmp/isolated-extension-host');
  assert.deepEqual(Object.keys(config).sort(), ['limits', 'sessions', 'storage', 'workers']);
  assert.deepEqual(config.limits, { pending_interactions: 32 });
  assert.equal(config.storage.root, '/tmp/isolated-extension-host/data');
  assert.equal(config.sessions.max_workers, 1);
  assert.equal(config.workers.pi.command, process.execPath);
});
test('real Extension Host preflight reports blocked without substituting mock/headless browser evidence', () => {
  assert.match(extensionHostBlocker('linux', {}), /No display/);
  assert.match(extensionHostBlocker('darwin', { DISPLAY: ':99' }), /Linux/);
  assert.equal(extensionHostBlocker('linux', { DISPLAY: ':99' }), undefined);
});
