import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Explicit artifacts never fall back to the development build, even on error.
export function resolveWorkbenchBinary(explicit) {
  const binary = explicit === undefined ? resolve('rust/target/debug/pi-acp-workbenchd') : explicit;
  if (!isAbsolute(binary)) throw new Error('Workbench binary must be an absolute path');
  if (!statSync(binary).isFile()) throw new Error('Workbench binary must be a regular file');
  accessSync(binary, constants.X_OK);
  return binary;
}
