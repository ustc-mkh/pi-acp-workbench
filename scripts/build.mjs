import { build } from 'esbuild';
import { mkdir, cp, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true }),
  build({ entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', target: 'es2022', sourcemap: true }),
  copyFile('webview/style.css', 'dist/style.css'),
  copyFile('node_modules/katex/dist/katex.min.css', 'dist/katex.min.css'),
  cp('node_modules/katex/dist/fonts', 'dist/fonts', { recursive: true }),
]);
await (await import('./build-adapter.mjs')).buildAdapter();
await import('./licenses.mjs');
