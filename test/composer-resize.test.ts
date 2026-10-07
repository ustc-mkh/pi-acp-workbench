// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { composerHeight, installComposerResize } from '../webview/composer-resize';
it('bounds input height and supports accessible keyboard resizing', () => {
  expect(composerHeight(-10, 800)).toBe(65);
  expect(composerHeight(900, 800)).toBe(440);
  const handle = document.createElement('div'),
    input = document.createElement('textarea'),
    persist = vi.fn();
  installComposerResize(handle, input, 100, persist);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
  expect(input.style.height).toBe('116px');
  expect(persist).toHaveBeenLastCalledWith(116);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
  expect(input.style.height).toBe('65px');
  expect(handle.getAttribute('aria-valuenow')).toBe('65');
  handle.dispatchEvent(new MouseEvent('dblclick'));
  expect(input.style.height).toBe('80px');
});
