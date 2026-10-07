import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These inputs are loaded by subprocesses or the build, outside Vite's import graph.
    forceRerunTriggers: [
      '**/package.json',
      '**/package-lock.json',
      '**/tsconfig.json',
      '**/vitest.config.*',
      '**/scripts/**',
      '**/rust/crates/**',
      '**/rust/Cargo.*',
      '**/test/mock-*.mjs',
      '**/src/{pi-enhancements,pi-native-fork,native-branch}.ts',
      '**/src/{adapter-store,adapter-errors}.ts',
    ],
  },
});
