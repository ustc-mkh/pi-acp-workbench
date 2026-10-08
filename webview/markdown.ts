import MarkdownIt from 'markdown-it';
import katex from 'katex';
import 'katex/contrib/mhchem';
import hljs from 'highlight.js/lib/common';
import taskLists from 'markdown-it-task-lists';
import footnotes from 'markdown-it-footnote';
import createDOMPurify, { type WindowLike } from 'dompurify';

const escaped = (s: string, i: number) => {
  let n = 0;
  while (i > 0 && s[--i] === '\\') n++;
  return n % 2 === 1;
};
function mathHtml(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      maxExpand: 500,
      maxSize: 20,
      output: 'htmlAndMathml',
      macros: { '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}' },
    });
  } catch {
    return `<code class="math-fallback" title="公式尚未完整或包含不支持的 LaTeX 命令">${md.utils.escapeHtml(source)}</code>`;
  }
}
const md: ReturnType<typeof MarkdownIt> = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  highlight(code, lang): string {
    const body =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : md.utils.escapeHtml(code);
    return `<pre class="code-block"><button class="copy-code" type="button" aria-label="复制代码">复制</button><code class="hljs language-${md.utils.escapeHtml(lang || 'text')}">${body}</code></pre>`;
  },
});
md.use(taskLists, { enabled: false, label: false });
md.use(footnotes);
const originalFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token.info.trim().toLowerCase() !== 'mermaid')
    return originalFence(tokens, index, options, env, self);
  const lines = String(env?.source || '').split('\n'),
    last = token.map ? lines[token.map[1] - 1] || '' : '';
  const closed = new RegExp('^\\s*' + token.markup[0] + '{' + token.markup.length + ',}\\s*$').test(
    last,
  );
  const code = md.utils.escapeHtml(token.content);
  if (!closed)
    return `<pre class="code-block"><button class="copy-code" type="button">复制</button><code>${code}</code></pre>`;
  return `<figure class="mermaid-diagram diagram-ready"><div class="diagram-canvas" aria-label="流程图"></div><details class="diagram-source"><summary>Mermaid 源码</summary><pre class="code-block"><button class="copy-code" type="button">复制</button><code>${code}</code></pre></details></figure>`;
};

// Delimiters are parsed as Markdown tokens, never regex-replaced across code spans/fences.
md.inline.ruler.before('escape', 'pi_math', (state, silent) => {
  const start = state.pos;
  let open = '',
    close = '',
    display = false;
  if (state.src.startsWith('\\(', start)) {
    open = '\\(';
    close = '\\)';
  } else if (state.src.startsWith('\\[', start)) {
    open = '\\[';
    close = '\\]';
    display = true;
  } else if (state.src.startsWith('$$', start)) {
    open = close = '$$';
    display = true;
  } else if (state.src[start] === '$' && state.src[start + 1] !== '$') {
    open = close = '$';
  }
  if (!open || (open === '$' && /\s/.test(state.src[start + 1] || ' '))) return false;
  let end = start + open.length;
  while ((end = state.src.indexOf(close, end)) >= 0) {
    if (
      !escaped(state.src, end) &&
      !(close === '$' && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || '')))
    )
      break;
    end += close.length;
  }
  if (end < 0 || end === start + open.length) return false;
  const source = state.src.slice(start + open.length, end);
  if (close === '$' && source.includes('\n')) return false;
  if (!silent) {
    const token = state.push('pi_math', 'math', 0);
    token.content = source;
    token.meta = { display };
  }
  state.pos = end + close.length;
  return true;
});
md.block.ruler.before(
  'fence',
  'pi_math_block',
  (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    let open = '',
      close = '',
      env = false;
    if (first.startsWith('$$')) open = close = '$$';
    else if (first.startsWith('\\[')) {
      open = '\\[';
      close = '\\]';
    } else {
      const match = first.match(
        /^\\begin\{(align\*?|aligned|gather\*?|gathered|equation\*?|multline\*?|cases|matrix|pmatrix|bmatrix)\}/,
      );
      if (match) {
        open = match[0];
        close = `\\end{${match[1]}}`;
        env = true;
      }
    }
    if (!open) return false;
    let line = start,
      body = first.slice(open.length),
      found = false;
    while (true) {
      const at = body.lastIndexOf(close);
      if (at >= 0 && !escaped(body, at) && body.slice(at + close.length).trim() === '') {
        body = body.slice(0, at);
        found = true;
        break;
      }
      if (++line >= end) break;
      body += '\n' + state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    }
    // Keep unfinished streaming math as ordinary escaped Markdown until the closing delimiter arrives.
    if (!found) return false;
    if (silent) return true;
    const token = state.push('pi_math_block', 'math', 0);
    token.block = true;
    token.content = env ? open + body + close : body.trim();
    token.map = [start, line + 1];
    state.line = line + 1;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
md.renderer.rules.pi_math = (tokens, i) => mathHtml(tokens[i].content, !!tokens[i].meta?.display);
md.renderer.rules.pi_math_block = (tokens, i) =>
  `<div class="math-block">${mathHtml(tokens[i].content, true)}</div>\n`;
// Remote image requests are deliberately not made by model-authored content.
md.renderer.rules.image = (tokens, i) =>
  `<span class="image-placeholder">[图片: ${md.utils.escapeHtml(tokens[i].content || 'image')}]</span>`;

export function createRenderer(window: Window) {
  const purify = createDOMPurify(window as Window & WindowLike);
  return (source: string) =>
    purify.sanitize(md.render(source, { source }), {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'img', 'foreignObject'],
      FORBID_ATTR: ['src', 'srcset', 'onerror', 'onclick'],
      ALLOW_DATA_ATTR: false,
    });
}
