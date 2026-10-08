#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { configureTelegram, findServiceDir, readSecret } from './lib/telegram-setup.mjs';

const { values } = parseArgs({
  options: { 'service-dir': { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log(
    'Usage: node scripts/setup-telegram.mjs [--service-dir /path/to/services]\n交互式 Telegram 配置：隐藏 token、配对群组/用户、用户级自启动。创建会话时指定项目目录。无需 sudo。',
  );
} else {
  let terminal;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('已取消'));
  process.on('SIGINT', cancel);
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64')
      throw new Error('目前仅支持 Linux x86_64');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22+');
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('请在交互式终端运行，token 不通过命令参数或管道输入');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const serviceDir = await findServiceDir(
      values['service-dir']
        ? [resolve(values['service-dir'])]
        : [
            root,
            join(homedir(), '.local/share/pi-acp-workbench/current'),
            join(root, 'service-dist'),
          ],
    );
    const ask = async (prompt) => {
      if (!terminal) {
        terminal = createInterface({ input: process.stdin, output: process.stdout });
        terminal.on('SIGINT', cancel);
      }
      return terminal.question(prompt, { signal: controller.signal });
    };
    const secret = async (prompt) => {
      terminal?.close();
      terminal = undefined;
      return readSecret(prompt);
    };
    console.log(`Telegram 配置向导（无需 sudo）\n服务程序：${serviceDir}`);
    await configureTelegram({ serviceDir, ask, secret, signal: controller.signal });
  } catch (error) {
    console.error(`配置未完成：${error.message}`);
    process.exitCode = 1;
  } finally {
    terminal?.close();
    process.off('SIGINT', cancel);
  }
}
