/** VS Code forwards webview keyup events to its menu bar. An Alt release from
 * a window switch must not look like a fresh, standalone menu activation. */
export function installAltReleaseGuard(view: Window = window) {
  let altPressedHere = false;
  const reset = () => {
    altPressedHere = false;
  };
  const down = (event: KeyboardEvent) => {
    if (event.key === 'Alt') altPressedHere = true;
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
  return () => {
    view.removeEventListener('keydown', down, true);
    view.removeEventListener('keyup', up, true);
    view.removeEventListener('blur', reset);
  };
}
