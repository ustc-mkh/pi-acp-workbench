import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// One development cutover, not an old-format reader or a migration registry.
export const releaseContract = Object.freeze({
  ipc: 3,
  storage: 3,
  rootPolicy: 'new-root-no-migration',
});
export const releaseDocuments = Object.freeze([
  'workbench-release.md',
  'workbench-cutover.md',
  'workbench-vscode.md',
  'workbench-ipc.md',
  'workbench-telegram.md',
  'workbench-storage.md',
  'turn-diff.md',
  'workbench-management.md',
  'feature-parity.md',
  'workbench-parity-execution.md',
  'workbench-parity-and-simplification-plan.md',
  // Historical evidence linked by the current plan, explicitly labelled historical.
  'workbench-follow-up-plan.md',
  'workbench-follow-up-plan-implementation-checkpoint.md',
  'workbench-follow-up-plan-t04-checkpoint.md',
]);
export async function verifyReleaseSources() {
  const root = 'rust/crates/pi-acp-workbenchd/src/';
  for (const [file, pattern, value] of [
    [root + 'domain/query.rs', /pub const PROTOCOL_VERSION: u32 = (\d+);/, releaseContract.ipc],
    ['src/workbench-protocol.ts', /export const PROTOCOL_VERSION_V3 = (\d+);/, releaseContract.ipc],
    [root + 'persistence.rs', /pub const FORMAT_VERSION: u32 = (\d+);/, releaseContract.storage],
  ])
    assert.equal(
      Number((await readFile(file, 'utf8')).match(pattern)?.[1]),
      value,
      `release contract disagrees with ${file}`,
    );
}
// Resolve only the fixed public document allowlist, never operator paths.
export async function verifyReleaseDocuments(read = (file) => readFile(`docs/${file}`, 'utf8')) {
  for (const file of releaseDocuments)
    for (const [, target] of (await read(file)).matchAll(/\]\(([^)\s]+)/g)) {
      if (target.includes(':') || target.startsWith('#')) continue;
      assert(
        releaseDocuments.includes(target.split('#')[0]),
        `unpackaged documentation link: ${file} -> ${target}`,
      );
    }
}
