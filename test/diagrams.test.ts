// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { safeDiagramSvg, renderDiagrams } from '../webview/diagrams';
const mermaid = vi.hoisted(() => ({
  loaded: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg><text>diagram</text></svg>' })),
}));
vi.mock('mermaid', () => {
  mermaid.loaded();
  return { default: mermaid };
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
it('removes executable SVG and external resources while retaining local arrow markers', () => {
  const result = safeDiagramSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>html</div></foreignObject><image href="https://example.com/track"/><a href="javascript:alert(1)"><text>link</text></a><style>.bad{fill:url(https://example.com/a)} .local{marker-end:url("#arrow")}</style><path marker-end="url(#arrow)" onclick="alert(1)"/></svg>',
  );
  expect(result).not.toMatch(/<script|<foreignObject|<image|<a\s|onclick|https:/);
  expect(result).toContain('url(#arrow)');
});
it('loads Mermaid only for valid diagrams and reuses the module across renders', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const root = document.createElement('div');
  document.body.append(root);
  await renderDiagrams(root);
  expect(mermaid.loaded).not.toHaveBeenCalled();
  const figure = (source: string) => {
    const node = document.createElement('figure');
    node.className = 'mermaid-diagram diagram-ready';
    node.innerHTML = '<div class="diagram-canvas"></div><code></code>';
    node.querySelector('code')!.textContent = source;
    root.append(node);
    return node;
  };
  const invalid = figure('%%{init: {}}%%\ngraph TD; A-->B');
  await renderDiagrams(root);
  expect(mermaid.loaded).not.toHaveBeenCalled();
  invalid.remove();
  const first = figure('graph TD; A-->B'),
    second = figure('graph TD; B-->C');
  await renderDiagrams(root);
  expect(mermaid.loaded).toHaveBeenCalledOnce();
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  expect(first.querySelector('svg')).not.toBeNull();
  expect(second.querySelector('svg')).not.toBeNull();
  await renderDiagrams(root);
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  const failing = figure('graph TD; C-->D');
  mermaid.render.mockRejectedValueOnce(new Error('temporary render failure'));
  await renderDiagrams(root);
  expect(failing.querySelector('.diagram-error')).not.toBeNull();
  await renderDiagrams(root);
  expect(mermaid.render).toHaveBeenCalledTimes(3);
  failing.querySelector('code')!.textContent = 'graph TD; C-->E';
  await renderDiagrams(root);
  expect(failing.querySelector('svg')).not.toBeNull();
  expect(failing.querySelector('.diagram-error')).toBeNull();
});
