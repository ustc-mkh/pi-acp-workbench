// Test-only launch fixture: select each mock ACP scenario without UI-owned processes.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [file, harness] = process.argv.slice(2);
const config = JSON.parse(readFileSync(file, 'utf8'));
const prefix = harness === 'pi' ? '' : harness + '.';
const command = config[prefix + 'command'] || process.execPath;
const args = config[prefix + 'args'] || config.args;
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, ...config[prefix + 'env'] },
});
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
