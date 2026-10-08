// Production services are Rust-only; keep native artifacts separate from VSIX.
import { spawn } from 'node:child_process';
import { mkdir, copyFile, chmod, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'out-dir': { type: 'string', default: 'service-dist' },
    'target-dir': { type: 'string' },
  },
});
const targets = {
  'x86_64-unknown-linux-gnu': { arch: 'x64', machine: 62, libc: 'glibc' },
  'x86_64-unknown-linux-musl': { arch: 'x64', machine: 62, libc: 'musl' },
};
const triple =
  values.target || execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!Object.hasOwn(targets, triple)) throw new Error(`Unsupported Linux target: ${triple}`);
const target = resolve(values['out-dir']);
const outputRelative = relative(process.cwd(), target);
if (!outputRelative || outputRelative.startsWith('..') || outputRelative.startsWith('.git'))
  throw new Error('out-dir must be a service artifact directory inside the workspace');
// Only replace our own generated directory, never a source/data directory.
try {
  const prior = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (prior.platform !== 'linux' || !prior.files?.['pi-acp-session-daemon'])
    throw new Error('out-dir does not contain a service artifact manifest');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { stat } = await import('node:fs/promises');
  try {
    await stat(target);
    throw new Error('Refusing to replace an unmanaged out-dir');
  } catch (check) {
    if (check.code !== 'ENOENT') throw check;
  }
}

if (process.platform !== 'linux')
  throw new Error('服务构建目前仅支持 Linux；VSIX 使用 npm run build。');
await new Promise((resolve, reject) => {
  const child = spawn(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      'rust/Cargo.toml',
      '--workspace',
      ...(values.target ? ['--target', triple] : []),
      ...(values['target-dir'] ? ['--target-dir', values['target-dir']] : []),
    ],
    { stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`cargo build failed (${code})`)),
  );
});
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const staging = `${target}.${randomUUID()}.tmp`;
const buildRoot = values['target-dir'] || process.env.CARGO_TARGET_DIR || 'rust/target';
const nativeDir = join(buildRoot, ...(values.target ? [triple] : []), 'release');
const rustSource = createHash('sha256');
async function hashSource(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === 'target') continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await hashSource(file);
    else if (/\.(rs|toml|lock)$/.test(file))
      rustSource
        .update(file)
        .update('\0')
        .update(await readFile(file))
        .update('\0');
  }
}
await hashSource('rust');
const source = { rustSha256: rustSource.digest('hex') };
try {
  source.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  source.modified = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
} catch {
  /* Source archives can be built without .git. */
}
const files = [
  'pi-acp-session-daemon',
  'pi-acp-telegram-daemon',
  'pi-adapter.mjs',
  'pi-native-fork.mjs',
];
await mkdir(staging, { mode: 0o755, recursive: true });
try {
  const hashes = {},
    abi = {};
  for (const file of files) {
    const native = file.endsWith('-daemon');
    await copyFile(join(native ? nativeDir : 'dist', file), join(staging, file));
    await chmod(join(staging, file), native ? 0o755 : 0o644);
    hashes[file] = createHash('sha256')
      .update(await readFile(join(staging, file)))
      .digest('hex');
    if (native) {
      const bytes = await readFile(join(staging, file));
      if (
        bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
        bytes[4] !== 2 ||
        bytes[5] !== 1 ||
        bytes.readUInt16LE(18) !== targets[triple].machine
      )
        throw new Error(`ELF architecture mismatch for ${file}`);
      const elfOptions = { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } };
      const dynamic = execFileSync('readelf', ['-d', join(staging, file)], elfOptions);
      const versions = execFileSync('readelf', ['--version-info', join(staging, file)], elfOptions);
      const segments = execFileSync('readelf', ['-l', join(staging, file)], elfOptions);
      const interpreter = segments.match(/Requesting program interpreter: ([^\]]+)/)?.[1];
      const libraries = [...dynamic.matchAll(/Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
      const glibc = [...versions.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      glibc.sort((a, b) => {
        const aa = a.split('.').map(Number),
          bb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
          const delta = (aa[i] || 0) - (bb[i] || 0);
          if (delta) return delta;
        }
        return 0;
      });
      abi[file] = {
        linkage: libraries.length || interpreter ? 'dynamic' : 'static',
        requiredLibraries: libraries,
        ...(interpreter ? { interpreter } : {}),
        ...(glibc.length ? { minimumGlibc: glibc.at(-1) } : {}),
      };
      if (targets[triple].libc === 'musl' && (libraries.length || glibc.length || interpreter))
        throw new Error(`musl release must be self-contained: ${file}`);
    }
  }
  await writeFile(
    join(staging, 'manifest.json'),
    JSON.stringify(
      {
        version,
        platform: 'linux',
        arch: targets[triple].arch,
        target: triple,
        libc: targets[triple].libc,
        node: '>=22',
        production: true,
        features: [],
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
        source,
        abi,
        tls: { provider: 'rustls', roots: 'bundled webpki-roots', openssl: false },
        files: hashes,
      },
      null,
      2,
    ) + '\n',
  );
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  console.log(`Rust production services ready: ${target} (${triple}; no contract-test feature)`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
