import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { sampleProcessTree } from './lib/workbench-process-tree.mjs';
test(
  'resource sample includes actual descendants and records an exited root',
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {spawn} from 'node:child_process'; const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.on('SIGTERM',()=>c.kill('SIGTERM')); c.once('exit',()=>process.exit(0)); console.log(c.pid);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const done = once(child, 'exit');
    try {
      const [chunk] = await once(child.stdout, 'data');
      const grandchild = Number(String(chunk).trim());
      const tree = await sampleProcessTree(child.pid);
      assert.equal(tree.count, 2);
      assert(tree.processes.some((p) => p.pid === grandchild));
      assert(tree.threads >= 2);
      assert(tree.rss_kib > 0);
      assert.equal(tree.exited_during_sample.length, 0);
      child.kill('SIGTERM');
      assert.deepEqual(await done, [0, null]);
      const exited = await sampleProcessTree(child.pid);
      assert.equal(exited.count, 0);
      assert.deepEqual(exited.exited_during_sample, [child.pid]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await done;
      }
    }
  },
);
