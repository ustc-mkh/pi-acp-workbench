import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createRenderer } from '../webview/markdown';
import { demoMarkdown } from '../src/demo';
const window = new JSDOM('').window;
const render = createRenderer(window as unknown as Window);
const doc = (source: string) => new JSDOM(render(source)).window.document;
describe('Markdown and mathematics', () => {
  it.each([
    String.raw`inline $E=mc^2$`,
    String.raw`inline \(\frac{a}{b}\)`,
    '$$x^2$$',
    String.raw`\[\int_0^1 x\,dx\]`,
    String.raw`\begin{align}a&=b\\c&=d\end{align}`,
    '$$\n\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}\n$$',
    '$$\\ce{2H2 + O2 -> 2H2O}$$',
  ])('renders %s as KaTeX and accessible MathML', (source) => {
    const d = doc(source);
    expect(d.querySelector('.katex')).not.toBeNull();
    expect(d.querySelector('math')).not.toBeNull();
    expect(d.querySelector('.math-fallback')).toBeNull();
  });
  it('renders equations in tables and lists', () => {
    const d = doc('| value |\n| --- |\n| $x^2$ |\n\n- \\(x+y\\)');
    expect(d.querySelectorAll('.katex')).toHaveLength(2);
    expect(d.querySelector('table')).not.toBeNull();
  });
  it('does not interpret code fences, inline code, escaped dollars, or prices', () => {
    const d = doc('```tex\n$x$ \\(y\\)\n```\n\n`$z$` and \\$q\\$ cost $5 and $10.');
    expect(d.querySelector('.katex')).toBeNull();
    expect(d.querySelector('pre code')?.textContent).toContain('$x$');
  });
  it('survives every partial prefix of a streamed equation and then renders the complete expression', () => {
    const source = String.raw`$$\sum_{i=0}^{n}\frac{i}{n}=\frac{n+1}{2}$$`;
    for (let i = 0; i < source.length; i++) expect(() => render(source.slice(0, i))).not.toThrow();
    expect(doc(source).querySelector('.katex')).not.toBeNull();
  });
  it('shows invalid or unsupported TeX as readable source', () => {
    const d = doc(String.raw`$$\nonexistentcommand{x}$$`);
    expect(d.querySelector('.math-fallback')?.textContent).toContain('nonexistentcommand');
  });
  it('supports GFM tables, tasks, strikethrough, footnotes and syntax highlighting', () => {
    const d = doc(
      '- [x] done\n\n~~removed~~\n\nNote[^1]\n\n[^1]: Footnote\n\n```js\nconst x = 1;\n```',
    );
    expect(d.querySelector('input[disabled]')).not.toBeNull();
    expect(d.querySelector('s')).not.toBeNull();
    expect(d.querySelector('.footnotes')).not.toBeNull();
    expect(d.querySelector('.hljs-keyword')).not.toBeNull();
  });
  it('blocks HTML, unsafe links, remote images and trusted KaTeX commands', () => {
    const d = doc(
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://tracker.invalid/a.png)\n\n$\\href{javascript:alert(1)}{x}$\n\n$\\includegraphics{https://tracker.invalid/a.png}$',
    );
    expect(d.querySelector('script,img,iframe')).toBeNull();
    expect([...d.querySelectorAll('a')].some((a) => a.href.startsWith('javascript:'))).toBe(false);
  });
  it('renders the shipped offline demo without broken math or code', () => {
    const d = doc(demoMarkdown);
    expect(d.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(7);
    expect(d.querySelector('.math-fallback')).toBeNull();
    expect(d.querySelector('pre code')?.textContent).toContain('numpy');
  });
});
it('waits for the closing Mermaid fence before scheduling a diagram and preserves source', () => {
  const source = '```mermaid\nflowchart TD\n A[开始] --> B[结束]\n';
  expect(doc(source).querySelector('.diagram-ready')).toBeNull();
  const d = doc(source + '```');
  expect(d.querySelector('.diagram-ready')).not.toBeNull();
  expect(d.querySelector('code')?.textContent).toContain('flowchart TD');
  expect(doc('```mermaid\n<script>alert(1)</script>\n```').querySelector('script')).toBeNull();
});
