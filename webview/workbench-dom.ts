/** Keep keyed messages/turns and unchanged text in place (focus/selection/scroll). */
export function reconcile(parent: HTMLElement, desired: HTMLElement) {
  const view = parent.ownerDocument.defaultView!;
  const key = (node: Node) =>
    node instanceof view.HTMLElement
      ? node.dataset.key || node.dataset.entry || node.dataset.turn
      : undefined;
  const keyed = new Map([...parent.childNodes].filter(key).map((node) => [key(node), node]));
  let cursor = parent.firstChild;
  for (const next of [...desired.childNodes]) {
    const id = key(next);
    const old = id
      ? keyed.get(id)
      : cursor && !key(cursor) && cursor.nodeName === next.nodeName
        ? cursor
        : undefined;
    let node = next;
    if (old) {
      node = old;
      if (old instanceof view.HTMLElement && next instanceof view.HTMLElement) {
        if (!next.dataset.definition || old.dataset.definition !== next.dataset.definition) {
          reconcile(old, next);
          old.onclick = next.onclick;
          for (const attr of [...old.attributes])
            if (!next.hasAttribute(attr.name)) old.removeAttribute(attr.name);
          for (const attr of [...next.attributes])
            if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
          if (old instanceof view.HTMLDetailsElement && next instanceof view.HTMLDetailsElement)
            old.open = next.open;
          if (old instanceof view.HTMLButtonElement && next instanceof view.HTMLButtonElement)
            old.disabled = next.disabled;
        }
      } else if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    }
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}
