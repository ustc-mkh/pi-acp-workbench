import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
const file = resolve('src/session-protocol.generated.ts');
const binary =
  process.env.PI_TEST_SESSION_DAEMON || resolve('rust/target/debug/pi-acp-session-daemon');
const source = execFileSync(binary, ['--print-types'], { encoding: 'utf8' });
const output = await format(source, { ...(await resolveConfig(file)), parser: 'typescript' });
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8')) !== output)
    throw new Error('Service types drifted. Run npm run generate:protocol.');
} else await writeFile(file, output);
