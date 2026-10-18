// Source-only audit graph: includes erased imports/types, not just esbuild's runtime graph.
// Reads files and compiler options; never evaluates repository source or imported modules.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export async function typescriptGraph(root, entries) {
  const base = resolve(root),
    configPath = resolve(base, 'tsconfig.json'),
    diagnostics = [];
  // Respect aliases and extended configs; fixtures may omit a config entirely.
  const config = ts.sys.fileExists(configPath)
    ? ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (error) => diagnostics.push(error),
        },
      )
    : undefined;
  assert(
    diagnostics.length === 0 &&
      (!ts.sys.fileExists(configPath) || (config && !config.errors.length)),
    'invalid TypeScript compiler configuration',
  );
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, ...config?.options },
    files = new Map();
  async function visit(path) {
    const file = resolve(base, path),
      key = relative(base, file).replaceAll('\\', '/');
    if (files.has(key)) return;
    const source = await readFile(file, 'utf8'),
      imports = ts.preProcessFile(source, true, true).importedFiles.map((item) => item.fileName);
    files.set(key, { source, imports });
    for (const specifier of imports) {
      const target = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!target) {
        assert(
          !specifier.startsWith('.'),
          `unresolved local TypeScript import: ${key}: ${specifier}`,
        );
      } else if (
        !target.isExternalLibraryImport &&
        !target.resolvedFileName.includes('/node_modules/')
      ) {
        await visit(target.resolvedFileName);
      }
    }
  }
  for (const entry of entries) await visit(entry);
  return files;
}
