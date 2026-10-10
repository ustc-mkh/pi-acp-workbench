import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOutputImage } from '../src/output-image';
import { MAX_IMAGE_BYTES } from '../src/images';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
it('loads bounded local raster images, including encoded names and file URIs, but refuses escapes and invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-output-image-'));
  const cwd = join(dir, 'workspace');
  await mkdir(cwd);
  try {
    const image = join(cwd, '示例 image.png');
    await writeFile(image, Buffer.from(png, 'base64'));
    expect((await readOutputImage(cwd, encodeURIComponent('示例 image.png'))).data).toBe(png);
    expect((await readOutputImage(cwd, pathToFileURL(image).href)).mimeType).toBe('image/png');
    await writeFile(join(dir, 'outside.png'), Buffer.from(png, 'base64'));
    await symlink(join(dir, 'outside.png'), join(cwd, 'escape.png'));
    await mkdir(join(dir, 'outside'));
    await writeFile(join(dir, 'outside', 'nested.png'), Buffer.from(png, 'base64'));
    await symlink(join(dir, 'outside'), join(cwd, 'linked-dir'));
    for (const source of [
      '../outside.png',
      '%2e%2e/outside.png',
      'escape.png',
      'linked-dir/nested.png',
      join(dir, 'outside.png'),
      'https://tracker.invalid/a.png',
      '//tracker.invalid/a.png',
      'data:image/png;base64,' + png,
      '%ZZ',
    ])
      await expect(readOutputImage(cwd, source)).rejects.toThrow();
    await writeFile(join(cwd, 'bad.png'), '<svg onload="alert(1)"></svg>');
    await writeFile(join(cwd, 'bad.svg'), '<svg/>');
    await writeFile(join(cwd, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    for (const source of ['bad.png', 'bad.svg', 'large.png', 'missing.png'])
      await expect(readOutputImage(cwd, source)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
