/** VS Code forwards webview keyup events to its menu bar. An Alt release from
 * a window switch must not look like a fresh, standalone menu activation. */
export function installAltReleaseGuard(view: Window = window) {
  let altPressedHere = false;
  const reset = () => {
    altPressedHere = false;
  };
  const down = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && event.altKey) reset();
    if (event.key !== 'Alt') return;
    if (!event.repeat) {
      altPressedHere = view.document.hasFocus() && !view.document.hidden;
    } else if (!altPressedHere && !event.ctrlKey && !event.metaKey) {
      // A held Alt can start repeating in the newly focused window.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const up = (event: KeyboardEvent) => {
    if (event.key !== 'Alt') return;
    const orphan = !altPressedHere;
    reset();
    if (orphan && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  // Capture before VS Code's bubbling key-forwarding listeners.
  view.addEventListener('keydown', down, true);
  view.addEventListener('keyup', up, true);
  view.addEventListener('blur', reset);
  view.addEventListener('focus', reset);
  view.addEventListener('pagehide', reset);
  view.document.addEventListener('visibilitychange', reset);
  return () => {
    view.removeEventListener('keydown', down, true);
    view.removeEventListener('keyup', up, true);
    view.removeEventListener('blur', reset);
    view.removeEventListener('focus', reset);
    view.removeEventListener('pagehide', reset);
    view.document.removeEventListener('visibilitychange', reset);
  };
}
