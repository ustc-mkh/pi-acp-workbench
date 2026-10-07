// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { installImagePaste, readPastedImage, imagePreview } from '../webview/image-paste';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
it('reads pasted image files, preserves mixed text, and tags async results with the original session', async () => {
  const file = new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'clipboard.png', {
    type: 'image/png',
  });
  expect((await readPastedImage(file)).data).toBe(png);
  const input = document.createElement('textarea'),
    send = vi.fn(),
    busy = vi.fn();
  let session = 'original';
  installImagePaste(input, () => session, send, busy);
  const event = new Event('paste', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '说明',
    },
  });
  input.dispatchEvent(event);
  session = 'other';
  expect(event.defaultPrevented).toBe(true);
  expect(input.value).toBe('说明');
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      type: 'attachImages',
      sessionId: 'original',
      images: [{ name: 'clipboard.png', mimeType: 'image/png', data: png }],
    }),
  );
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(imagePreview('image/png', png, '图片')?.src).toBe('data:image/png;base64,' + png);
  expect(imagePreview('image/svg+xml', png, 'bad')).toBeUndefined();
});
it('does not intercept normal text paste', () => {
  const input = document.createElement('textarea');
  installImagePaste(input, () => undefined, vi.fn(), vi.fn());
  const event = new Event('paste', { cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: () => 'text' } });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
