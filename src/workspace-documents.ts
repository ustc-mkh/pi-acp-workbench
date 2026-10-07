import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { Entry } from './shared';

/** All transcript file navigation stays behind the same workspace/realpath boundary. */
export async function openWorkspaceLink(cwd: string, url: string, line?: number) {
  if (typeof url !== 'string' || url.length > 10000) return;
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  if (!cwd || (/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('file:'))) return;
  const target = url.startsWith('file:')
    ? vscode.Uri.parse(url).fsPath
    : path.resolve(cwd, url.split('#')[0]);
  const [root, actual] = await Promise.all([realpath(cwd), realpath(target)]),
    relative = path.relative(root, actual);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
    throw new Error('只能从聊天打开当前会话工作区内的文件。');
  const row =
    typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line - 1 : undefined;
  await vscode.window.showTextDocument(vscode.Uri.file(actual), {
    preview: true,
    selection: row === undefined ? undefined : new vscode.Range(row, 0, row, 0),
  });
}

/** Bounded virtual documents shared by tool diffs and final per-turn summaries. */
export class DiffDocuments implements vscode.Disposable {
  private previews = new Map<string, { documents: Map<string, string>; bytes: number }>();
  private provider = vscode.workspace.registerTextDocumentContentProvider('pi-acp-diff', {
    provideTextDocumentContent: (uri) => {
      for (const preview of this.previews.values()) {
        const text = preview.documents.get(uri.toString());
        if (text !== undefined) return text;
      }
      return '';
    },
  });
  private keep(key: string, documents: [vscode.Uri, string][]) {
    const texts = new Map(documents.map(([uri, text]) => [uri.toString(), text]));
    this.previews.delete(key);
    this.previews.set(key, {
      documents: texts,
      bytes: [...texts.values()].reduce((n, text) => n + Buffer.byteLength(text), 0),
    });
    while (
      this.previews.size > 1 &&
      (this.previews.size > 20 ||
        [...this.previews.values()].reduce((n, p) => n + p.bytes, 0) > 16 * 1024 * 1024)
    )
      this.previews.delete(this.previews.keys().next().value!);
  }
  async open(sessionId: string | undefined, entry: Entry | undefined, index: number) {
    if (!entry || !Number.isInteger(index)) return;
    const key = encodeURIComponent(`${sessionId || 'preview'}-${entry.id}-${index}`);
    if (entry.role === 'diff' && index === -1) {
      const documents: [vscode.Uri, string][] = [];
      const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
      const omitted: string[] = [];
      entry.diff.files.forEach((file, fileIndex) => {
        if (file.before === undefined || file.after === undefined) {
          omitted.push(file.path);
          return;
        }
        const uri = (side: string) =>
          vscode.Uri.from({
            scheme: 'pi-acp-diff',
            path: `/${key}/${fileIndex}/${side}/${file.path}`,
          });
        const left = uri('before'),
          right = uri('after');
        documents.push([left, file.before], [right, file.after]);
        resources.push([
          uri('file'),
          file.status === 'added' ? undefined : left,
          file.status === 'deleted' ? undefined : right,
        ]);
      });
      if (resources.length) {
        this.keep(key, documents);
        await vscode.commands.executeCommand('vscode.changes', '本轮修改', resources);
      }
      if (omitted.length)
        await vscode.window.showInformationMessage(
          `${omitted.length} 个文件未保存完整文本，无法原生对比：${omitted.join('、')}。请在改动卡片中查看原因。`,
        );
      return;
    }
    const content = entry.role === 'tool' ? entry.tool.content?.[index] : undefined;
    const file = entry.role === 'diff' ? entry.diff.files[index] : undefined;
    const change =
      content?.type === 'diff'
        ? { path: content.path, before: content.oldText || '', after: content.newText }
        : file && file.before !== undefined && file.after !== undefined
          ? { path: file.path, before: file.before, after: file.after }
          : undefined;
    if (!change) return;
    const uri = (side: string) =>
      vscode.Uri.from({
        scheme: 'pi-acp-diff',
        path: `/${key}/${side}/${path.basename(change.path)}`,
      });
    const left = uri('before'),
      right = uri('after');
    this.keep(key, [
      [left, change.before],
      [right, change.after],
    ]);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.basename(change.path)} · ${entry.role === 'diff' ? '本轮修改' : 'Agent 修改'}`,
      { preview: true },
    );
  }
  dispose() {
    this.provider.dispose();
    this.previews.clear();
  }
}
