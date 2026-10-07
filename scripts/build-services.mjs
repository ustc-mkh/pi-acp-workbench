// Production services are Rust-only; keep native artifacts separate from VSIX.
import { spawn } from 'node:child_process';
import { mkdir, copyFile, chmod, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

if (process.platform !== 'linux')
  throw new Error('服务构建目前仅支持 Linux；VSIX 使用 npm run build。');
await new Promise((resolve, reject) => {
  const child = spawn(
    'cargo',
    ['build', '--release', '--manifest-path', 'rust/Cargo.toml', '--workspace'],
    { stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`cargo build failed (${code})`)),
  );
});
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const target = resolve('service-dist'),
  staging = `${target}.${randomUUID()}.tmp`;
const files = [
  'pi-acp-session-daemon',
  'pi-acp-telegram-daemon',
  'pi-adapter.mjs',
  'pi-native-fork.mjs',
];
await mkdir(staging, { mode: 0o755 });
try {
  const hashes = {};
  for (const file of files) {
    const native = file.endsWith('-daemon');
    await copyFile(join(native ? 'rust/target/release' : 'dist', file), join(staging, file));
    await chmod(join(staging, file), native ? 0o755 : 0o644);
    hashes[file] = createHash('sha256')
      .update(await readFile(join(staging, file)))
      .digest('hex');
  }
  await writeFile(
    join(staging, 'manifest.json'),
    JSON.stringify(
      { version, platform: process.platform, arch: process.arch, node: '>=22', files: hashes },
      null,
      2,
    ) + '\n',
  );
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
  console.log(
    `Rust production services ready: ${target} (${process.arch}; no contract-test feature)`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
