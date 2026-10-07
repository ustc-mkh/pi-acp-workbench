/** One immediate, theme-aware tooltip surface for static and streamed content. */
export function installTooltips(doc: Document = document) {
  const tip = doc.createElement('div');
  tip.id = 'chat-tooltip';
  tip.className = 'chat-tooltip';
  tip.role = 'tooltip';
  tip.hidden = true;
  doc.body.append(tip);
  let active: HTMLElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    if (active) {
      const ids = (active.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== tip.id);
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
      else active.removeAttribute('aria-describedby');
    }
    active = undefined;
    tip.hidden = true;
  };
  const position = () => {
    if (!active?.isConnected || !active.getClientRects().length) {
      hide();
      return;
    }
    const box = active.getBoundingClientRect(),
      size = tip.getBoundingClientRect();
    const width = doc.documentElement.clientWidth,
      height = doc.documentElement.clientHeight;
    const above = box.top >= size.height + 16;
    tip.dataset.placement = above ? 'above' : 'below';
    tip.style.left = `${Math.max(8, Math.min(width - size.width - 8, box.left + box.width / 2 - size.width / 2))}px`;
    tip.style.top = `${Math.max(8, Math.min(height - size.height - 8, above ? box.top - size.height - 8 : box.bottom + 8))}px`;
  };
  const show = (target: HTMLElement) => {
    if (!target.dataset.tooltip) {
      hide();
      return;
    }
    if (hideTimer) clearTimeout(hideTimer);
    if (active !== target) hide();
    active = target;
    tip.textContent = target.dataset.tooltip;
    tip.hidden = false;
    const ids = new Set(
      (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean),
    );
    ids.add(tip.id);
    target.setAttribute('aria-describedby', [...ids].join(' '));
    position();
  };
  const targetOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
  const over = (event: Event) => {
    if (event.target instanceof Node && tip.contains(event.target)) {
      if (hideTimer) clearTimeout(hideTimer);
      return;
    }
    const target = targetOf(event.target);
    if (target) show(target);
  };
  const out = (event: Event) => {
    const next = (event as MouseEvent).relatedTarget;
    if (next instanceof Node && (active?.contains(next) || tip.contains(next))) return;
    // Only dismissal has a short grace period so the floating text is hoverable.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 80);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') hide();
  };
  const normalize = (root: Element) => {
    const nodes = root.matches('[title]')
      ? [root, ...root.querySelectorAll('[title]')]
      : root.querySelectorAll('[title]');
    for (const node of nodes) {
      const title = node.getAttribute('title');
      if (title) node.setAttribute('data-tooltip', title);
      node.removeAttribute('title');
    }
  };
  normalize(doc.body);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'title')
        normalize(record.target as Element);
      for (const node of record.addedNodes)
        if (node instanceof Element && node !== tip) normalize(node);
    }
    if (active) {
      if (!active.isConnected || !active.getClientRects().length || !active.dataset.tooltip) hide();
      else {
        if (tip.textContent !== active.dataset.tooltip) tip.textContent = active.dataset.tooltip;
        position();
      }
    }
  });
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title', 'data-tooltip', 'hidden'],
  });
  doc.addEventListener('pointerover', over, true);
  doc.addEventListener('focusin', over, true);
  doc.addEventListener('pointerout', out, true);
  doc.addEventListener('focusout', out, true);
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('keydown', key);
  doc.addEventListener('scroll', hide, true);
  doc.defaultView?.addEventListener('resize', hide);
  return () => {
    hide();
    observer.disconnect();
    tip.remove();
    doc.removeEventListener('pointerover', over, true);
    doc.removeEventListener('focusin', over, true);
    doc.removeEventListener('pointerout', out, true);
    doc.removeEventListener('focusout', out, true);
    doc.removeEventListener('pointerdown', hide, true);
    doc.removeEventListener('keydown', key);
    doc.removeEventListener('scroll', hide, true);
    doc.defaultView?.removeEventListener('resize', hide);
  };
}
