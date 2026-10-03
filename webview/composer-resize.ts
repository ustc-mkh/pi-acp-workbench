export function composerHeight(value:number, viewport:number) {
  return Math.round(Math.max(65, Math.min(value, Math.max(65, viewport * 0.55))));
}

/** Accessible separator, with pointer capture so dragging works outside the handle. */
export function installComposerResize(handle:HTMLElement, input:HTMLTextAreaElement, saved:number|undefined, persist:(height:number)=>void) {
  let height = Number.isFinite(saved) ? saved! : 80;
  let drag: {id:number;y:number;height:number} | undefined;
  const apply = (value:number) => {
    height = composerHeight(value, window.innerHeight);
    input.style.height = `${height}px`;
    handle.setAttribute('aria-valuemin','65');
    handle.setAttribute('aria-valuemax',String(composerHeight(Infinity,window.innerHeight)));
    handle.setAttribute('aria-valuenow',String(height));
  };
  apply(height);
  handle.addEventListener('pointerdown', event => {
    if(event.button !== 0) return;
    event.preventDefault(); drag = {id:event.pointerId,y:event.clientY,height};
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-composer');
  });
  handle.addEventListener('pointermove', event => {
    if(drag?.id === event.pointerId) apply(drag.height + drag.y - event.clientY);
  });
  const finish = () => { if(!drag) return; drag = undefined; document.body.classList.remove('resizing-composer'); persist(height); };
  handle.addEventListener('pointerup', event => { if(drag?.id === event.pointerId) { finish(); if(handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); } });
  handle.addEventListener('pointercancel',finish);
  handle.addEventListener('lostpointercapture',finish);
  handle.addEventListener('keydown', event => {
    if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    apply(event.key === 'Home' ? 65 : event.key === 'End' ? Infinity : height + (event.key === 'ArrowUp' ? 16 : -16));
    persist(height);
  });
  handle.addEventListener('dblclick', () => { apply(80); persist(height); });
  window.addEventListener('resize', () => apply(height));
}
