import { build } from 'esbuild';
import { mkdir, cp, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true }),
  build({ entryPoints: ['src/session-daemon.ts'], outfile: 'dist/session-daemon.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
    banner:{js:'import { createRequire as __sessionRequire } from "node:module"; const require = __sessionRequire(import.meta.url);'} }),
  build({ entryPoints: ['src/telegram-daemon.ts'], outfile: 'dist/telegram-daemon.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
    banner:{js:'import { createRequire as __telegramRequire } from "node:module"; const require = __telegramRequire(import.meta.url);'} }),
  build({ entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', target: 'es2022', sourcemap: true }),
  copyFile('webview/style.css', 'dist/style.css'),
  copyFile('node_modules/katex/dist/katex.min.css', 'dist/katex.min.css'),
  cp('node_modules/katex/dist/fonts', 'dist/fonts', { recursive: true }),
]);
await (await import('./build-adapter.mjs')).buildAdapter();
await import('./licenses.mjs');
