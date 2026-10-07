import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
const [service, ...args] = process.argv.slice(2);
const names = { sessions: 'pi-acp-session-daemon', telegram: 'pi-acp-telegram-daemon' };
if (!Object.hasOwn(names, service)) throw new Error('Expected sessions or telegram');
const binary = resolve('service-dist', names[service]);
try {
  await access(binary);
} catch {
  throw new Error('缺少 Rust 服务产物，请先运行 npm run build:services。');
}
const child = spawn(binary, args, { stdio: 'inherit' });
const interrupt = () => child.kill('SIGINT'),
  terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
