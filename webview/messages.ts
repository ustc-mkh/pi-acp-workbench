import type { Entry, UiMessage } from '../src/shared';
import { turnDiffTitle } from '../src/turn-diff';
import { contentImage, hydrateInlineImages } from './output-images';
import { messageActions } from './message-actions';

const button = (text: string, action: () => void, className?: string) => {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = text;
  if (className) node.className = className;
  node.onclick = action;
  return node;
};
function turnDiffNode(
  entry: Extract<Entry, { role: 'diff' }>,
  send: (message: UiMessage) => void,
): HTMLElement {
  const node = document.createElement('article');
  node.className = 'message turn-diff';
  const header = document.createElement('div');
  header.className = 'turn-diff-header';
  const title = document.createElement('strong');
  title.textContent = turnDiffTitle(entry.diff);
  header.append(title);
  if (entry.diff.files.length)
    header.append(
      button('查看总 Diff', () => send({ type: 'diff', id: entry.id, index: -1 }), 'diff-link'),
    );
  node.append(header);
  const files = document.createElement('details');
  files.className = 'turn-diff-files';
  const filesTitle = document.createElement('summary');
  filesTitle.textContent = `全部修改（${entry.diff.files.length} 个文件）`;
  files.append(filesTitle);
  node.append(files);
  const notes = document.createElement('div');
  notes.className = 'turn-diff-notes';
  if (!entry.diff.files.length && entry.diff.status !== 'unavailable') {
    const empty = document.createElement('p');
    empty.textContent =
      entry.diff.status === 'complete'
        ? '本轮未检测到文件净变化。'
        : '已采集范围内未检测到净变化；未采集文件见下方说明。';
    notes.append(empty);
  }
  entry.diff.files.forEach((file, index) => {
    const details = document.createElement('details');
    details.className = 'turn-diff-file';
    const summary = document.createElement('summary');
    summary.textContent = `${{ added: '新增', modified: '修改', deleted: '删除' }[file.status]} · ${file.path}  +${file.added} −${file.removed}`;
    details.append(summary);
    // Materialize only the file the user expands. Full patches remain available in the editor.
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      rendered = true;
      if (file.before !== undefined && file.after !== undefined)
        details.append(
          button('在编辑器中对比', () => send({ type: 'diff', id: entry.id, index }), 'diff-link'),
        );
      if (file.omitted) {
        const note = document.createElement('p');
        note.textContent = file.omitted;
        details.append(note);
      }
      if (
        file.oldMode !== undefined &&
        file.newMode !== undefined &&
        file.oldMode !== file.newMode
      ) {
        const mode = document.createElement('p');
        mode.textContent = `文件类型/权限：${file.oldMode.toString(8)} → ${file.newMode.toString(8)}`;
        details.append(mode);
      }
      if (file.patch) {
        const pre = document.createElement('pre');
        pre.className = 'turn-diff-patch';
        const lines = file.patch.slice(0, 30000).split('\n').slice(0, 400);
        for (const line of lines) {
          const span = document.createElement('span');
          span.textContent = line + '\n';
          span.className = line.startsWith('+')
            ? 'diff-add'
            : line.startsWith('-')
              ? 'diff-remove'
              : line.startsWith('@@')
                ? 'diff-hunk'
                : '';
          pre.append(span);
        }
        details.append(pre);
        if (lines.join('\n').length < file.patch.length) {
          const note = document.createElement('p');
          note.textContent = '预览已截断；在编辑器中查看完整差异。';
          details.append(note);
        }
      }
    });
    files.append(details);
  });
  for (const warning of entry.diff.warnings) {
    const p = document.createElement('p');
    p.className = 'diff-warning';
    p.textContent = warning;
    notes.append(p);
  }
  if (notes.childElementCount) files.append(notes);
  return node;
}

/** Message rendering is independent from page orchestration and transcript grouping. */
export function createMessageRenderer(
  renderMarkdown: (text: string) => string,
  sessionId: () => string | undefined,
  send: (message: UiMessage) => void,
  hydrateImages: (node: HTMLElement) => void = hydrateInlineImages,
) {
  return (entry: Entry): HTMLElement => {
    if (entry.role === 'diff') return turnDiffNode(entry, send);
    const node = document.createElement(
      entry.role === 'tool' || entry.role === 'thought' ? 'details' : 'article',
    );
    node.className = `message ${entry.role}`;
    if (entry.role === 'tool') {
      const summary = document.createElement('summary');
      const labels: Record<string, string> = {
        pending: '等待',
        in_progress: '执行中',
        completed: '完成',
        failed: '失败',
      };
      summary.textContent = `${entry.tool.status === 'completed' ? '✓' : entry.tool.status === 'failed' ? '×' : '◇'} ${entry.tool.title}`;
      const badge = document.createElement('span');
      badge.className = `badge ${entry.tool.status}`;
      badge.textContent = labels[entry.tool.status || 'pending'];
      summary.append(badge);
      node.append(summary);
      const body = document.createElement('div');
      body.className = 'tool-body';
      for (const location of entry.tool.locations || [])
        body.append(
          button(
            `${location.path}${location.line ? ':' + location.line : ''}`,
            () => send({ type: 'open', url: location.path, line: location.line ?? undefined }),
            'file-link',
          ),
        );
      const content = [...(entry.tool.content || [])];
      if (
        entry.terminal &&
        !content.some((c) => c.type === 'terminal' && c.terminalId === entry.terminal!.id)
      )
        content.push({ type: 'terminal', terminalId: entry.terminal.id });
      content.forEach((content, index) => {
        if (content.type === 'diff') {
          body.append(
            button(
              `查看修改 · ${content.path}`,
              () => send({ type: 'diff', id: entry.id, index }),
              'diff-link',
            ),
          );
          const before = document.createElement('pre'),
            after = document.createElement('pre');
          before.className = 'diff-before';
          after.className = 'diff-after';
          before.textContent = (content.oldText || '').slice(0, 4000);
          after.textContent = content.newText.slice(0, 4000);
          body.append(before, after);
        } else if (content.type === 'content') {
          const image = contentImage(content.content);
          if (image) {
            body.append(image);
            return;
          }
          const text =
            content.content.type === 'text' ? content.content.text : `[${content.content.type}]`;
          const markdown = document.createElement('div');
          markdown.className = 'markdown';
          markdown.innerHTML = renderMarkdown(text);
          body.append(markdown);
        } else {
          const terminal = entry.terminal?.id === content.terminalId ? entry.terminal : undefined;
          const pre = document.createElement('pre');
          pre.className = 'terminal-output';
          pre.tabIndex = 0;
          pre.setAttribute('aria-label', '终端输出');
          pre.textContent =
            terminal?.output ||
            (entry.tool.status === 'completed' ? '命令已完成，没有文本输出。' : '等待终端输出…');
          body.append(pre);
          if (terminal?.truncated) {
            const note = document.createElement('p');
            note.textContent = '输出过长，仅保留最近约 100 万字符。';
            body.append(note);
          }
          if (terminal?.exitCode !== undefined || terminal?.signal) {
            const status = document.createElement('small');
            status.textContent = terminal.signal
              ? `终止信号：${terminal.signal}`
              : `退出码：${terminal.exitCode ?? '未知'}`;
            body.append(status);
          }
        }
      });
      if (entry.tool.rawInput != null || entry.tool.rawOutput != null) {
        const raw = document.createElement('details'),
          label = document.createElement('summary'),
          pre = document.createElement('pre');
        label.textContent = '原始输入 / 输出';
        pre.textContent = JSON.stringify(
          { input: entry.tool.rawInput, output: entry.tool.rawOutput },
          null,
          2,
        );
        raw.append(label, pre);
        body.append(raw);
      }
      node.append(body);
    } else {
      if (entry.role === 'thought') {
        const summary = document.createElement('summary');
        summary.textContent = '思考过程';
        node.append(summary);
      }
      const body = document.createElement('div');
      body.className = 'markdown';
      body.innerHTML = renderMarkdown(entry.text);
      node.append(body);
      for (const block of entry.contextBlocks || []) {
        const image = contentImage(block, '消息图片');
        if (image) node.append(image);
      }
    }
    if (entry.role === 'assistant' || entry.role === 'user' || entry.role === 'tool')
      node.append(messageActions(entry, sessionId, send));
    hydrateImages(node);
    return node;
  };
}
