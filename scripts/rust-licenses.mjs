import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export async function writeRustNotices(target, output) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        'rust/Cargo.toml',
        '--format-version',
        '1',
        '--filter-platform',
        target,
        '--locked',
        '--offline',
      ],
      { encoding: 'utf8' },
    ),
  );
  const selected = new Set(metadata.resolve.nodes.map((node) => node.id));
  const notices = [
    'Rust dependency notices for pi-acp-workbench production services.\n',
    'License declarations and versions are from Cargo.lock and published crate manifests.\n',
  ];
  for (const pkg of metadata.packages
    .filter((p) => p.source && selected.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    notices.push(
      `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license || 'See license file'}\n` +
        `Repository: ${pkg.repository || ''}\nAuthors: ${pkg.authors.join(', ')}\n`,
    );
    const directory = dirname(pkg.manifest_path);
    const files = (await readdir(directory)).filter((file) =>
      /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(file),
    );
    if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
    const texts = [];
    for (const file of files) {
      try {
        texts.push(await readFile(join(directory, file), 'utf8'));
      } catch (error) {
        if (error.code !== 'EISDIR') throw error;
      }
    }
    if (!texts.length && ['ts-rs', 'ts-rs-macros'].includes(pkg.name) && pkg.version === '11.1.0') {
      // Published crates omit LICENSE; exact upstream tag: Aleph-Alpha/ts-rs v11.1.0.
      texts.push(await readFile('scripts/licenses/ts-rs-11.1.0.LICENSE', 'utf8'));
    }
    assert(texts.length, `Missing dependency license text: ${pkg.name}@${pkg.version}`);
    notices.push(...texts);
  }
  await writeFile(join(output, 'RUST_THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
  await cp(
    join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'),
    join(output, 'RUST_RUNTIME_NOTICES.html'),
  );
  await cp(join(sysroot, 'share/doc/rust/licenses'), join(output, 'rust-licenses'), {
    recursive: true,
  });
}
