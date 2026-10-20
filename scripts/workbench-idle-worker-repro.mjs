import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const { WorkbenchWire, turnFinished } = await import(
  pathToFileURL(resolve('test/helpers/workbench-wire.mjs'))
);
const root = await mkdtemp(join(tmpdir(), 'parity-idle-'));
let wire, child;
try {
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'workspace'));
  const config = join(root, 'config.json');
  const { extensionHostConfig } = await import(
    pathToFileURL(resolve('scripts/workbench-extension-host.mjs'))
  );
  await writeFile(config, JSON.stringify(extensionHostConfig(root)));
  child = spawn(resolve('rust/target/debug/pi-acp-workbenchd'), ['--config', config], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (c) => (log = (log + c).slice(-8192)));
  for (let i = 0; i < 100; i++) {
    try {
      wire = await WorkbenchWire.open(join(root, 'data/workbench.sock'));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!wire) throw Error(log);
  const create = async () =>
    (
      await wire.call(
        { method: 'create', harness: 'Pi', cwd: join(root, 'workspace') },
        randomUUID(),
      )
    ).Created.summary.id;
  const a = await create();
  await wire.call({ method: 'attach', session: a });
  const finished = wire.waitFor((b) => turnFinished(b, a));
  console.log(
    'A prompt receipt',
    await wire.call({ method: 'prompt', session: a, prompt: 'first' }, randomUUID()),
  );
  await finished;
  console.log('A finished and remains idle');
  const b = await create();
  await wire.call({ method: 'attach', session: b });
  const failed = wire.waitFor(
    (batch) => batch.session === b && typeof batch.view?.status === 'object',
  );
  console.log(
    'B prompt receipt',
    await wire.call({ method: 'prompt', session: b, prompt: 'second' }, randomUUID()),
  );
  console.log('B terminal view', JSON.stringify((await failed).view.status));
  try {
    await wire.call({ method: 'cancel', session: a }, randomUUID());
  } catch (error) {
    console.log('Idle A cancel rejected:', error.message);
  }
  await wire.call({ method: 'remove', session: a }, randomUUID());
  const recovered = wire.waitFor((batch) => turnFinished(batch, b));
  console.log(
    'B explicit retry after removing idle A',
    await wire.call(
      { method: 'prompt', session: b, prompt: 'explicit diagnostic retry' },
      randomUUID(),
    ),
  );
  await recovered;
  console.log('B finished after idle A released its slot');
} finally {
  wire?.close();
  if (child && child.exitCode === null) {
    const done = new Promise((r) => child.once('close', r));
    child.kill('SIGTERM');
    await done;
  }
  await rm(root, { recursive: true, force: true });
}
