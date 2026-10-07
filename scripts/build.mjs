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
