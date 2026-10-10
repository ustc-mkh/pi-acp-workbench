import * as path from 'node:path';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, validateImage, type PastedImage } from './images';

/** Read only bounded raster images inside the conversation's real working directory. */
export async function readOutputImage(cwd: string, source: string): Promise<PastedImage> {
  if (!cwd || !source || source.length > 4096 || /[\x00-\x1f]/.test(source))
    throw new Error('图片路径无效。');
  let filename: string;
  if (/^file:/i.test(source)) {
    const url = new URL(source);
    if (url.search || url.hash) throw new Error('图片路径无效。');
    filename = fileURLToPath(url);
  } else {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
      throw new Error('不自动加载远程图片。');
    filename = path.resolve(cwd, decodeURIComponent(source));
  }
  const root = await realpath(cwd);
  const target = await realpath(filename);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('图片不在当前会话工作目录内。');
  const mimeType = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }[path.extname(target).toLowerCase()];
  if (!mimeType) throw new Error('只支持 PNG、JPEG、WebP 和 GIF 图片。');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // Verify the opened descriptor as well on Linux, closing parent-symlink races.
    if (process.platform === 'linux') {
      const opened = await realpath(`/proc/self/fd/${file.fd}`);
      const rel = path.relative(root, opened);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        throw new Error('图片不在当前会话工作目录内。');
    }
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('图片不可读或超过 3 MB。');
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 3 MB。');
    const image = {
      name: path.basename(target),
      mimeType,
      data: bytes.subarray(0, size).toString('base64'),
    };
    validateImage(image);
    return image;
  } finally {
    await file.close();
  }
}
