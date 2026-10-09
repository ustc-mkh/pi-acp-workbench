// Validate tag/version/provenance and both archives before permitting publication.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag must match package version');
const output = resolve('service-artifacts');
const vsix = `pi-acp-workbench-${version}.vsix`;
const name = `pi-acp-services-${version}-x86_64-unknown-linux-musl`;
const archive = `${name}.tar.gz`;
execFileSync('sha256sum', ['-c', `${archive}.sha256`], { cwd: output, stdio: 'inherit' });
const scratch = await mkdtemp(join(tmpdir(), 'pi-release-check-'));
try {
  const entries = execFileSync('tar', ['-tzf', join(output, archive)], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert(entries.every((p) => p.startsWith(`${name}/`) && !p.split('/').includes('..')));
  execFileSync('tar', ['-xzf', join(output, archive), '-C', scratch]);
  const directory = join(scratch, name);
  execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: directory, stdio: 'inherit' });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.target, 'x86_64-unknown-linux-musl');
  assert.equal(manifest.production, true);
  assert.deepEqual(manifest.features, []);
  assert.equal(manifest.source.commit, process.env.GITHUB_SHA);
  assert.equal(manifest.source.modified, false);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
const packaged = JSON.parse(
  execFileSync('unzip', ['-p', join(output, vsix), 'extension/package.json'], { encoding: 'utf8' }),
);
assert.equal(packaged.version, version);
const entries = execFileSync('unzip', ['-Z1', join(output, vsix)], { encoding: 'utf8' }).split(
  '\n',
);
assert(entries.includes('extension/dist/extension.cjs'));
assert(entries.includes('extension/docs/service-release.md'));
assert(
  !entries.some((p) => /(?:\.map$|\/node_modules\/|\/archive\/|\/service-dist\/|-daemon$)/.test(p)),
);
const smoke = JSON.parse(
  await readFile('test-results/production-x86_64-unknown-linux-musl.json', 'utf8'),
);
assert.equal(smoke.passed, true);
const assets = [vsix, archive, `${archive}.sha256`];
const sums = await Promise.all(
  assets.map(
    async (file) =>
      `${createHash('sha256')
        .update(await readFile(join(output, file)))
        .digest('hex')}  ${file}`,
  ),
);
await writeFile(join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
const changelog = await readFile('CHANGELOG.md', 'utf8');
const section = changelog.split(`## ${version} — `)[1];
assert(section, 'Changelog must contain this version');
const notes = section
  .slice(section.indexOf('\n') + 1)
  .split('\n## ')[0]
  .trim();
await writeFile(
  join(output, 'release-notes.md'),
  `升级时请配套更新 VSIX、会话 daemon 和 Telegram relay，并备份数据；新旧 socket 客户端不可混用。服务包适用于 Linux x86_64，采用静态 musl；服务器仍需 Node.js 22+ 和相应 Agent 命令。\n\n${notes}\n\n### 验证范围\n\n本标签通过 CI 的 Rust / npm 审计、格式与 clippy、完整服务回归、浏览器冒烟以及实际 musl 生产包 smoke / 契约。附件下载后通过 SHA-256 复核。本地 2 小时浸泡结果及所用产物见随包 docs/rust-acceptance.md（不是 CI 的检查项）；本次未验证实际 VS Code Extension Host、真实付费模型或真实 Telegram 群组。\n`,
);
console.log(`Verified release v${version}: ${assets.join(', ')}`);
