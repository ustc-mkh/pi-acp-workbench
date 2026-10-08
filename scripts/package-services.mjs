// Package a verified production directory without publishing it.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, rename, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { writeRustNotices } from './rust-licenses.mjs';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'service-dist' },
    'out-dir': { type: 'string', default: 'service-artifacts' },
  },
});
const source = resolve(values.dir),
  output = resolve(values['out-dir']);
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
assert.equal(manifest.production, true);
assert.deepEqual(manifest.features, []);
assert.equal(manifest.platform, 'linux');
assert.equal(manifest.arch, 'x64');
assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version));
assert(['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'].includes(manifest.target));
const files = [
  'pi-acp-session-daemon',
  'pi-acp-telegram-daemon',
  'pi-adapter.mjs',
  'pi-native-fork.mjs',
];
assert.deepEqual(Object.keys(manifest.files).sort(), files.toSorted());
for (const file of files) {
  const bytes = await readFile(join(source, file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[file]);
  if (file.endsWith('-daemon'))
    assert(
      bytes.subarray(0, 4).toString('hex') === '7f454c46' &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes.readUInt16LE(18) === 62,
      `Expected Linux x86_64 ELF: ${file}`,
    );
}
const name = `pi-acp-services-${manifest.version}-${manifest.target}`;
const temporary = await mkdtemp(join(tmpdir(), 'pi-service-package-'));
const staging = join(temporary, name),
  archive = join(output, `${name}.tar.gz`);
const pending = `${archive}.${randomUUID()}.tmp`;
await mkdir(output, { recursive: true });
try {
  await mkdir(staging);
  // Never copy an operator's added config/token/history into a release archive.
  for (const file of [...files, 'manifest.json']) await cp(join(source, file), join(staging, file));
  await cp('LICENSE', join(staging, 'LICENSE'));
  await cp('docs/service-release.md', join(staging, 'README.md'));
  await cp('docs/service-release.md', join(staging, 'service-release.md'));
  await cp('docs/rust-acceptance.md', join(staging, 'rust-acceptance.md'));
  await mkdir(join(staging, 'archive'));
  await cp('docs/archive/rust-migration.md', join(staging, 'archive', 'rust-migration.md'));
  await cp('THIRD_PARTY_NOTICES.txt', join(staging, 'THIRD_PARTY_NOTICES.txt'));
  await writeRustNotices(manifest.target, staging);
  await mkdir(join(staging, 'examples'));
  for (const file of [
    'pi-sessions.service',
    'pi-telegram.service',
    'sessions.json',
    'telegram.json',
  ])
    await cp(join('examples', file), join(staging, 'examples', file));
  const sums = [];
  async function checksums(directory = '') {
    for (const entry of (await readdir(join(staging, directory), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await checksums(file);
      else
        sums.push(
          `${createHash('sha256')
            .update(await readFile(join(staging, file)))
            .digest('hex')}  ${file}`,
        );
    }
  }
  await checksums();
  await writeFile(join(staging, 'SHA256SUMS'), sums.join('\n') + '\n');
  execFileSync('tar', ['-czf', pending, '-C', temporary, name]);
  await rename(pending, archive);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
  console.log(`${archive}\nSHA-256 ${digest}`);
} finally {
  await rm(pending, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
