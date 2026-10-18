import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { releaseNotes, validateRelease } from './prepare-release.mjs';

function fixture() {
  const bytes = Buffer.from('fixture binary');
  const files = { 'pi-acp-workbenchd': createHash('sha256').update(bytes).digest('hex') };
  return {
    version: '1.2.3',
    tag: 'v1.2.3',
    commit: 'a'.repeat(40),
    manifest: {
      version: '1.2.3',
      target: 'x86_64-unknown-linux-musl',
      production: true,
      features: [],
      source: { commit: 'a'.repeat(40), modified: false },
      files,
      abi: { interpreter: null },
    },
    packaged: { version: '1.2.3' },
    entries: ['extension/dist/extension.cjs', 'extension/docs/workbench-release.md'],
    smoke: {
      passed: true,
      target: 'x86_64-unknown-linux-musl',
      files: { ...files },
      abi: { interpreter: null },
      checks: ['actual artifact smoke'],
    },
    files: { 'pi-acp-workbenchd': bytes },
    changelog:
      '# Changes\n\n## 1.2.3 — 2026-01-01\n\nVerified changes.\n\n## 1.2.2 — older\nOld changes.',
  };
}

test('pure release validator accepts complete matching fixture and extracts only current notes', () => {
  assert.equal(validateRelease(fixture()), 'Verified changes.');
  const notes = releaseNotes('Current changes.');
  assert(notes.includes('唯一的 pi-acp-workbenchd'));
  assert(notes.includes('docs/workbench-release.md'));
  assert(!/rust-acceptance|Telegram relay|会话 daemon|2 小时/.test(notes));
});

const failures = {
  tag: (f) => {
    f.tag = 'v1.2.2';
  },
  version: (f) => {
    f.manifest.version = '1.2.2';
  },
  'VSIX version': (f) => {
    f.packaged.version = '1.2.2';
  },
  documentation: (f) => {
    f.entries[1] = 'extension/docs/service-release.md';
  },
  'forbidden VSIX contents': (f) => {
    f.entries.push('extension/node_modules/secret');
  },
  dirty: (f) => {
    f.manifest.source.modified = true;
  },
  'missing dirty provenance': (f) => {
    delete f.manifest.source.modified;
  },
  commit: (f) => {
    f.manifest.source.commit = 'b'.repeat(40);
  },
  'missing CI commit': (f) => {
    delete f.commit;
  },
  production: (f) => {
    f.manifest.production = false;
  },
  features: (f) => {
    f.manifest.features = ['test'];
  },
  target: (f) => {
    f.manifest.target = 'x86_64-unknown-linux-gnu';
  },
  'binary hash': (f) => {
    f.files['pi-acp-workbenchd'] = Buffer.from('different binary');
  },
  'legacy binaries': (f) => {
    f.manifest.files['pi-acp-session-daemon'] = '0'.repeat(64);
  },
  'failed smoke': (f) => {
    f.smoke.passed = false;
  },
  'wrong smoke target': (f) => {
    f.smoke.target = 'x86_64-unknown-linux-gnu';
  },
  'wrong smoke hash': (f) => {
    f.smoke.files['pi-acp-workbenchd'] = '0'.repeat(64);
  },
  'wrong smoke ABI': (f) => {
    f.smoke.abi.interpreter = '/ld.so';
  },
  'empty smoke': (f) => {
    f.smoke.checks = [];
  },
  changelog: (f) => {
    f.changelog = '# no matching version';
  },
};
for (const [name, mutate] of Object.entries(failures))
  test(`release rejects ${name}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => validateRelease(data));
  });
