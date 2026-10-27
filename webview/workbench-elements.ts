import { uiLabel } from './workbench-labels';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, click: () => void, disabled = false, translate = true) {
  const full = translate ? uiLabel(label) : label;
  const short: Record<string, string> = {
    'Copy message': '复制',
    'Use as prompt': '重用',
    'Fork here': '分支',
  };
  const node = element('button', translate ? short[label] || full : full);
  if (translate && short[label]) node.setAttribute('aria-label', full);
  if (label === 'Use as prompt' && translate) node.classList.add('message-reuse');
  node.type = 'button';
  node.disabled = disabled;
  node.onclick = click;
  return node;
}
