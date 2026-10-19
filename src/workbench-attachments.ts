import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { TextDecoder } from 'node:util';

import { MAX_ATTACHMENT_BYTES, type TextAttachment } from './workbench-input';

/** Only called for files explicitly selected by the user, never tool/Markdown URIs. */
export async function readTextAttachment(
  path: string,
  workspace: string,
): Promise<Omit<TextAttachment, 'id'>> {
  const root = await realpath(workspace);
  const source = await realpath(path);
  const name = relative(root, source);
  if (!name || name === '..' || name.startsWith('../') || isAbsolute(name))
    throw new Error('Choose a file inside the selected session workspace');
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_ATTACHMENT_BYTES)
      throw new Error('Choose a regular UTF-8 text file up to 64 KiB (no hard links)');
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await file.stat();
    if (
      count > MAX_ATTACHMENT_BYTES ||
      before.size !== count ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (await realpath(path)) !== source
    )
      throw new Error('File changed while reading; select it again');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    if (text.includes('\0')) throw new Error('Binary attachments are not supported');
    return { name, text };
  } finally {
    await file.close();
  }
}
