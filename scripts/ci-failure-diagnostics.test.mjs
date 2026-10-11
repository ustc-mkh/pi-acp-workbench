import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-failure-diagnostics.mjs', import.meta.url));

test('annotates only failed suites and retains bounded, escaped failure summaries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-ci-diagnostics-'));
  try {
    const run = join(cwd, '.test-results/run-current');
    await mkdir(run, { recursive: true });
    await writeFile(join(run, 'failures.json'), JSON.stringify(['typescript.log']));
    await writeFile(join(run, 'build-debug.log'), 'Finished successfully');
    await writeFile(
      join(run, 'typescript.log'),
      'passed test\n'.repeat(1000) + '\u001b[31mFAIL real failure\u001b[0m\n100%\r\n',
    );
    const output = execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.match(output, /::error title=Failure diagnostics::/);
    assert.match(output, /FAIL real failure%0A100%25%0D%0A/);
    assert.doesNotMatch(output, /build-debug|Finished successfully|\u001b/);
    assert.equal(output.split('::error').length - 1, 1);
    assert(output.length < 4096);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('does not label unclassified logs as failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-ci-diagnostics-'));
  try {
    await mkdir(join(cwd, '.test-results/run-current'), { recursive: true });
    const output = execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.match(output, /::warning::No failed-suite manifest/);
    assert.doesNotMatch(output, /::error/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
