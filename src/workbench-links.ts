import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validate at the host boundary too; WHATWG URL serializes IDNs as punycode. */
export function externalDestination(value: string): string {
  if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error('Invalid external destination');
  const url = new URL(value);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only credential-free HTTP(S) and mailto links may be opened');
  return url.href;
}

export type LinkDestination = { kind: 'external'; url: string } | { kind: 'file'; path: string };

export function linkDestination(value: string, cwd?: string): LinkDestination {
  if (/^(?:https?|mailto):/i.test(value))
    return { kind: 'external', url: externalDestination(value) };

  if (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error('Invalid file link');
  if (/^file:/i.test(value)) {
    if (!/^file:\//i.test(value)) throw new Error('Invalid file URL');
    const path = fileURLToPath(value);
    if (/^\/\/|\0/.test(path)) throw new Error('Invalid file path');
    return { kind: 'file', path };
  }

  const pathname = value.replace(/^sandbox:(?=\/(?!\/))/i, '').split(/[?#]/, 1)[0];
  if (!pathname || /^(?:\/\/|[a-z][a-z\d+.-]*:)|%2f/i.test(pathname))
    throw new Error('Unsupported file link');
  const path = decodeURIComponent(pathname);
  if (/\0/.test(path)) throw new Error('Invalid file path');
  if (isAbsolute(path)) return { kind: 'file', path };
  if (!cwd) throw new Error('Select a session before opening a relative file link');
  return { kind: 'file', path: resolve(cwd, path) };
}
