// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createRenderer } from '../webview/markdown';
import { createMessageRenderer } from '../webview/messages';
import { OutputImages } from '../webview/output-images';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const image = { name: 'sample', mimeType: 'image/png', data: png };
const render = createRenderer(window);
it('renders assistant, thought, tool, embedded resource and inline Markdown raster images', () => {
  const message = createMessageRenderer(render, () => 's', vi.fn());
  for (const role of ['user', 'assistant', 'thought'] as const) {
    const node = message({
      id: role,
      role,
      text: 'image',
      contextBlocks: [{ type: 'image', mimeType: 'image/png', data: png }],
    });
    expect(node.querySelector('img')?.src).toBe('data:image/png;base64,' + png);
  }
  const tool = message({
    id: 't',
    role: 'tool',
    tool: {
      toolCallId: 't',
      title: 'Image',
      content: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: png } },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///image.png', mimeType: 'image/png', blob: png },
          },
        },
      ],
    },
  });
  expect(tool.querySelectorAll('img')).toHaveLength(2);
  const inline = message({
    id: 'a',
    role: 'assistant',
    text: `![示例](data:image/png;base64,${png})`,
  });
  expect(inline.querySelector('img')?.alt).toContain('示例');
  const unsafe = message({
    id: 'x',
    role: 'assistant',
    text: '![remote](https://tracker.invalid/x.png)\n\n![svg](data:image/svg+xml;base64,PHN2Zy8+)\n\n<img src="https://tracker.invalid/a.png" onerror="alert(1)">',
  });
  expect(unsafe.querySelector('img')).toBeNull();
  expect(unsafe.querySelector('[data-image-source]')).toBeNull();
});
it('deduplicates requests, queues to four reads, caches images, retries failures and ignores stale replies', () => {
  const send = vi.fn(),
    images = new OutputImages(send);
  images.setScope('pi', 'one');
  const node = document.createElement('div');
  node.innerHTML = render('![one](./a.png) ![two](./a.png)');
  images.hydrate(node);
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0][0];
  expect(request).toMatchObject({
    type: 'readOutputImage',
    url: './a.png',
    harness: 'pi',
    sessionId: 'one',
  });
  images.receive({ type: 'outputImage', id: request.id, image });
  expect(node.querySelectorAll('img')).toHaveLength(2);
  const cached = document.createElement('div');
  cached.innerHTML = render('![cached](./a.png)');
  images.hydrate(cached);
  expect(cached.querySelector('img')).not.toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  const queued = document.createElement('div');
  queued.innerHTML = render(Array.from({ length: 6 }, (_, i) => `![${i}](./${i}.png)`).join(' '));
  images.hydrate(queued);
  expect(send).toHaveBeenCalledTimes(5);
  images.receive({ type: 'outputImage', id: send.mock.calls[1][0].id, error: 'unavailable' });
  expect(send).toHaveBeenCalledTimes(6);
  expect(queued.querySelector('[role=button]')?.textContent).toContain('点击重试');
  const old = send.mock.calls[2][0].id;
  images.setScope('codex', 'two');
  images.receive({ type: 'outputImage', id: old, image });
  expect(queued.querySelector('img')).toBeNull();
  const fresh = document.createElement('div');
  fresh.innerHTML = render('![fresh](./a.png)');
  images.hydrate(fresh);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ harness: 'codex', sessionId: 'two' });
  const failed = send.mock.calls.at(-1)![0].id;
  images.receive({ type: 'outputImage', id: failed, error: 'missing' });
  fresh.querySelector<HTMLElement>('[role=button]')!.click();
  const retry = send.mock.calls.at(-1)![0].id;
  expect(retry).not.toBe(failed);
  images.receive({ type: 'outputImage', id: retry, image });
  expect(fresh.querySelector('img')).not.toBeNull();
});
