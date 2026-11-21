import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { installAltReleaseGuard } from '../webview/workbench-keyboard';

let dom: JSDOM;
afterEach(() => dom.window.close());
function setup() {
  dom = new JSDOM('<textarea></textarea><button>Other control</button>', {
    pretendToBeVisual: true,
  });
  const view = dom.window;
  const input = view.document.querySelector('textarea')!;
  const forwarded: string[] = [];
  // The host registers its bubbling listener before loading the webview script.
  for (const type of ['keydown', 'keyup'])
    view.addEventListener(type, (event) =>
      forwarded.push(`${event.type}:${(event as KeyboardEvent).key}`),
    );
  const dispose = installAltReleaseGuard(view as unknown as Window);
  input.focus();
  const key = (type: string, value: string, options: KeyboardEventInit = {}) => {
    const event = new view.KeyboardEvent(type, {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    input.dispatchEvent(event);
    return event;
  };
  return { view, input, forwarded, dispose, key };
}

it('blocks an Alt release arriving after a window switch before host menu forwarding', () => {
  const b = setup();
  b.key('keydown', 'Alt');
  b.view.dispatchEvent(new b.view.Event('blur'));
  b.view.dispatchEvent(new b.view.Event('focus'));
  // Typing may already have resumed before the delayed Alt keyup arrives.
  b.key('keydown', 'a');
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(true);
  expect(b.forwarded).toEqual(['keydown:Alt', 'keydown:a']);
  expect(b.view.document.activeElement).toBe(b.input);
});

it('blocks a release whose Alt press happened outside the webview', () => {
  const b = setup();
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(true);
  expect(b.forwarded).toEqual([]);
});

it('does not re-arm menu activation when held Alt repeats after focus returns', () => {
  const b = setup();
  b.key('keydown', 'Alt');
  b.view.dispatchEvent(new b.view.Event('focus'));
  expect(b.key('keydown', 'Alt', { repeat: true, altKey: true }).defaultPrevented).toBe(true);
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(true);
  expect(b.forwarded).toEqual(['keydown:Alt']);
  b.key('keydown', 'Alt');
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(false);
});

it('invalidates a held Alt on Tab or a visibility change even without a window blur', () => {
  const b = setup();
  b.key('keydown', 'Alt');
  expect(b.key('keydown', 'Tab', { altKey: true }).defaultPrevented).toBe(false);
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(true);
  b.key('keydown', 'Alt');
  b.view.document.dispatchEvent(new b.view.Event('visibilitychange'));
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(true);
});

it('preserves deliberate Alt menu activation, shortcuts, and normal focus navigation', () => {
  const b = setup();
  b.key('keydown', 'Alt');
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(false);
  for (const value of ['Tab', 'F10', 'Escape', 'c']) {
    expect(b.key('keydown', value, { ctrlKey: value === 'c' }).defaultPrevented).toBe(false);
    b.key('keyup', value);
  }
  expect(b.key('keyup', 'AltGraph').defaultPrevented).toBe(false);
  expect(b.key('keyup', 'Alt', { ctrlKey: true }).defaultPrevented).toBe(false);
  const other = b.view.document.querySelector('button')!;
  other.focus();
  expect(b.view.document.activeElement).toBe(other);
  expect(b.forwarded).toContain('keyup:Alt');
  b.dispose();
  expect(b.key('keyup', 'Alt').defaultPrevented).toBe(false);
});
