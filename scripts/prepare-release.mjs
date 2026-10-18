// Pure release validation is also used by fixture tests; no GitHub release is created here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = 'x86_64-unknown-linux-musl';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateRelease({
  version,
  tag,
  commit,
  manifest,
  packaged,
  entries,
  smoke,
  files,
  changelog,
}) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(tag, `v${version}`, 'Tag must match package version');
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.version, version);
  assert.equal(manifest.target, target);
  assert.equal(manifest.production, true);
  assert.deepEqual(manifest.features, []);
  assert.equal(manifest.source.commit, commit);
  assert.equal(manifest.source.modified, false);
  assert.deepEqual(Object.keys(manifest.files), ['pi-acp-workbenchd']);
  assert.deepEqual(Object.keys(files), ['pi-acp-workbenchd']);
  for (const [name, bytes] of Object.entries(files))
    assert.equal(sha256(bytes), manifest.files[name]);
  assert.equal(packaged.version, version);
  assert(entries.includes('extension/dist/extension.cjs'));
  assert(entries.includes('extension/docs/workbench-release.md'));
  assert(
    !entries.some((p) =>
      /(?:\.map$|\/node_modules\/|\/archive\/|\/service-dist\/|-daemon$)/.test(p),
    ),
  );
  assert.equal(smoke.passed, true);
  assert.equal(smoke.target, target);
  assert.deepEqual(smoke.files, manifest.files, 'Smoke must verify the packaged binary');
  assert.deepEqual(smoke.abi, manifest.abi);
  assert(Array.isArray(smoke.checks) && smoke.checks.length > 0);
  const section = changelog.split(`## ${version} — `)[1];
  assert(section, 'Changelog must contain this version');
  return section
    .slice(section.indexOf('\n') + 1)
    .split('\n## ')[0]
    .trim();
}

export function releaseNotes(notes) {
  return `升级时请配套更新 VSIX 和唯一的 pi-acp-workbenchd，并先离线备份数据；不同版本的 socket 客户端不可混用。服务包适用于 Linux x86_64，采用静态 musl；Node.js 22+ 及相应 Agent 命令由操作者另行安装。部署和恢复步骤见 docs/workbench-release.md。\n\n${notes}\n\n### 验证范围\n\n发布准备校验版本/tag、干净源码 provenance、归档与二进制哈希、VSIX 内容和匹配该 musl 产物的 smoke report。具体 CI 契约与回归结果以本标签的工作流日志为准；不以历史浸泡或 GNU 结果替代本次 musl 验证。本次未验证实际 VS Code Extension Host、真实付费模型或真实 Telegram 群组。\n`;
}

export async function prepareRelease() {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  // Reject mismatched tags before extracting anything.
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag must match package version');
  const output = resolve('service-artifacts');
  const vsix = `pi-acp-workbench-${version}.vsix`;
  const name = `pi-acp-services-${version}-${target}`;
  const archive = `${name}.tar.gz`;
  execFileSync('sha256sum', ['-c', `${archive}.sha256`], { cwd: output, stdio: 'inherit' });
  const scratch = await mkdtemp(join(tmpdir(), 'pi-release-check-'));
  let notes;
  try {
    const archiveEntries = execFileSync('tar', ['-tzf', join(output, archive)], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    assert(archiveEntries.every((p) => p.startsWith(`${name}/`) && !p.split('/').includes('..')));
    execFileSync('tar', ['-xzf', join(output, archive), '-C', scratch]);
    const directory = join(scratch, name);
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: directory, stdio: 'inherit' });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const packaged = JSON.parse(
      execFileSync('unzip', ['-p', join(output, vsix), 'extension/package.json'], {
        encoding: 'utf8',
      }),
    );
    const entries = execFileSync('unzip', ['-Z1', join(output, vsix)], { encoding: 'utf8' }).split(
      '\n',
    );
    const smoke = JSON.parse(await readFile(`test-results/production-${target}.json`, 'utf8'));
    notes = validateRelease({
      version,
      tag: process.env.GITHUB_REF_NAME,
      commit: process.env.GITHUB_SHA,
      manifest,
      packaged,
      entries,
      smoke,
      files: { 'pi-acp-workbenchd': await readFile(join(directory, 'pi-acp-workbenchd')) },
      changelog: await readFile('CHANGELOG.md', 'utf8'),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const assets = [vsix, archive, `${archive}.sha256`];
  const sums = await Promise.all(
    assets.map(async (file) => `${sha256(await readFile(join(output, file)))}  ${file}`),
  );
  await writeFile(join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
  await writeFile(join(output, 'release-notes.md'), releaseNotes(notes));
  console.log(`Verified release v${version}: ${assets.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepareRelease();
