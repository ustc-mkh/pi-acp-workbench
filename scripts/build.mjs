import { build } from 'esbuild';
import { mkdir, cp, copyFile, rm } from 'node:fs/promises';
// Hashed lazy chunks must not accumulate or ship stale code in VSIX.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/session-daemon.ts'],
    outfile: 'dist/session-daemon.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    banner: {
      js: 'import { createRequire as __sessionRequire } from "node:module"; const require = __sessionRequire(import.meta.url);',
    },
  }),
  build({
    entryPoints: ['src/telegram-daemon.ts'],
    outfile: 'dist/telegram-daemon.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    banner: {
      js: 'import { createRequire as __telegramRequire } from "node:module"; const require = __telegramRequire(import.meta.url);',
    },
  }),
  build({
    entryPoints: ['webview/main.ts'],
    outdir: 'dist',
    entryNames: 'webview',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    format: 'esm',
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: true,
  }),
  copyFile('webview/style.css', 'dist/style.css'),
  copyFile('node_modules/katex/dist/katex.min.css', 'dist/katex.min.css'),
  cp('node_modules/katex/dist/fonts', 'dist/fonts', { recursive: true }),
]);
await (await import('./build-adapter.mjs')).buildAdapter();
await import('./licenses.mjs');
