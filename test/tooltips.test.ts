// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installTooltips } from '../webview/tooltips';
let dispose: () => void;
beforeEach(() => {
  document.body.innerHTML = '<button title="历史记录">历史</button>';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 100, height: 25 }] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 280, y: 5, left: 280, top: 5, right: 310, bottom: 30, width: 100, height: 25, toJSON() {} });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(500);
  dispose = installTooltips();
});
afterEach(() => { dispose(); vi.restoreAllMocks(); });
it('immediately shows a theme tooltip without native titles, stays within the viewport, and dismisses on Escape', () => {
  const button = document.querySelector('button')!;
  expect(button.hasAttribute('title')).toBe(false);
  button.dispatchEvent(new Event('pointerover', { bubbles: true }));
  const tip = document.querySelector<HTMLElement>('#chat-tooltip')!;
  expect(tip.hidden).toBe(false); expect(tip.textContent).toBe('历史记录');
  expect(tip.dataset.placement).toBe('below'); expect(parseFloat(tip.style.left)).toBeLessThanOrEqual(212);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(tip.hidden).toBe(true); expect(button.hasAttribute('aria-describedby')).toBe(false);
});
it('normalizes titles in streamed content and dismisses tooltips whose target disappears', async () => {
  const link = document.createElement('a'); link.title = '链接说明'; link.textContent = '链接'; document.body.append(link);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(link.hasAttribute('title')).toBe(false); expect(link.dataset.tooltip).toBe('链接说明');
  link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect(document.querySelector<HTMLElement>('#chat-tooltip')!.hidden).toBe(false);
  link.remove(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector<HTMLElement>('#chat-tooltip')!.hidden).toBe(true);
});
