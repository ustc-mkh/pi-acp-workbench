import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verifyReleaseDocuments,
  verifyReleaseSources,
  releaseDocuments,
} from './lib/release-contract.mjs';
import { extensionHostBlocker } from './workbench-extension-host.mjs';
test('Rust/TS/build contract is one current cutover and packaged documents have no dangling local links', async () => {
  await verifyReleaseSources();
  await verifyReleaseDocuments();
  assert(releaseDocuments.includes('workbench-cutover.md'));
  assert(releaseDocuments.includes('turn-diff.md'));
  assert(releaseDocuments.includes('workbench-management.md'));
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
test('real Extension Host preflight reports blocked without substituting mock/headless browser evidence', () => {
  assert.match(extensionHostBlocker('linux', {}), /No display/);
  assert.match(extensionHostBlocker('darwin', { DISPLAY: ':99' }), /Linux/);
  assert.equal(extensionHostBlocker('linux', { DISPLAY: ':99' }), undefined);
});
