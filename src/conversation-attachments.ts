import * as vscode from 'vscode';
import * as path from 'node:path';
import { openWorkspaceLink } from './workspace-documents';
import { validateImage, MAX_ATTACHMENT_IMAGE_BYTES } from './images';
import { nextId } from './state';
import type { UiMessage, OutputImageReply } from './shared';
import { readOutputImage } from './output-image';
import type { ActiveConversation } from './active-conversation';
import type { HarnessId } from './harness';
import type { DiffDocuments } from './workspace-documents';

export interface AttachmentHost {
  readonly config: Pick<vscode.WorkspaceConfiguration, 'get'>;
  readonly state: ActiveConversation['state'];
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly generation: number;
  postOutputImage(reply: OutputImageReply): void;
  readonly documents: Pick<DiffDocuments, 'open'>;
  emit(): void;
}

/** Coordinates attachments, previews and conversation export using the current UI state. */
export class AttachmentCoordinator {
  constructor(private readonly host: AttachmentHost) {}

  async attach() {
    try {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区。');
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file')
        throw new Error('请先打开需要添加的代码文件。');
      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const limit = this.host.config.get('maxContextChars', 60000);
      if (text.length > limit) throw new Error(`上下文超过 ${limit} 字符，请选择更小的代码片段。`);
      if (this.host.state.attachments.length >= 8)
        throw new Error('每条消息最多附加 8 个代码片段。');
      const name =
        path.basename(editor.document.fileName) +
        (selection.isEmpty ? '' : `:${selection.start.line + 1}-${selection.end.line + 1}`);
      this.host.state.attachments = [
        ...this.host.state.attachments,
        { id: nextId(), name, uri: editor.document.uri.toString(), text },
      ];
      await vscode.commands.executeCommand('piAcp.chat.focus');
      this.host.emit();
    } catch (error) {
      this.host.state.error = String(error);
      this.host.emit();
    }
  }

  async onAttachImages(message: UiMessage & { type: 'attachImages' }): Promise<void> {
    if (message.harness !== undefined && message.harness !== this.host.harness)
      throw new Error('Harness 已切换，请重新粘贴图片。');
    if (message.sessionId !== this.host.state.sessionId)
      throw new Error('会话已切换，请重新粘贴图片。');
    if (
      !Array.isArray(message.images) ||
      !message.images.length ||
      message.images.length + this.host.state.attachments.length > 8
    )
      throw new Error('每条消息最多附加 8 个附件。');
    const total =
      message.images.reduce((n, image) => n + validateImage(image), 0) +
      this.host.state.attachments.reduce(
        (n, a) => n + (a.kind === 'image' ? Buffer.byteLength(a.data, 'base64') : 0),
        0,
      );
    if (total > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error('每条消息的图片总大小不能超过 6 MB。');
    this.host.state.attachments = [
      ...this.host.state.attachments,
      ...message.images.map((image) => ({
        kind: 'image' as const,
        id: nextId(),
        name: image.name.slice(0, 120) || '粘贴图片',
        mimeType: image.mimeType,
        data: image.data,
      })),
    ];
    this.host.emit();
  }

  async onAttachmentError(message: UiMessage & { type: 'attachmentError' }): Promise<void> {
    if (
      (message.harness === undefined || message.harness === this.host.harness) &&
      message.sessionId === this.host.state.sessionId
    ) {
      this.host.state.error = String(message.error).slice(0, 300);
      this.host.emit();
    }
  }

  async onAttach(): Promise<void> {
    await this.attach();
  }

  async onRemoveAttachment(message: UiMessage & { type: 'removeAttachment' }): Promise<void> {
    this.host.state.attachments = this.host.state.attachments.filter((a) => a.id !== message.id);
    this.host.emit();
  }

  private imageReads = 0;
  async onReadOutputImage(message: UiMessage & { type: 'readOutputImage' }): Promise<void> {
    const { generation, cwd, harness } = this.host;
    if (message.harness !== harness || message.sessionId !== this.host.state.sessionId) return;
    if (!vscode.workspace.isTrusted || this.imageReads >= 4) {
      this.host.postOutputImage({
        type: 'outputImage',
        id: message.id,
        error: '工作区未受信任或图片加载过多。',
      });
      return;
    }
    this.imageReads++;
    let reply: OutputImageReply;
    try {
      reply = {
        type: 'outputImage',
        id: message.id,
        image: await readOutputImage(cwd, message.url),
      };
    } catch {
      reply = {
        type: 'outputImage',
        id: message.id,
        error: '图片不可用：需为当前工作目录内、不超过 3 MB 的 PNG / JPEG / WebP / GIF。',
      };
    } finally {
      this.imageReads--;
    }
    if (
      generation === this.host.generation &&
      harness === this.host.harness &&
      cwd === this.host.cwd &&
      message.sessionId === this.host.state.sessionId
    )
      this.host.postOutputImage(reply);
    else
      this.host.postOutputImage({
        type: 'outputImage',
        id: message.id,
        error: '会话已切换，请重试。',
      });
  }

  async onOpen(message: UiMessage & { type: 'open' }): Promise<void> {
    await openWorkspaceLink(this.host.cwd, message.url, message.line);
  }

  async onDiff(message: UiMessage & { type: 'diff' }): Promise<void> {
    await this.host.documents.open(
      this.host.state.sessionId,
      this.host.state.entries.find((e) => e.id === message.id),
      message.index,
    );
  }

  async onExport(): Promise<void> {
    await this.exportChat();
  }

  conversationText() {
    return this.host.state.entries
      .map((e) =>
        e.role === 'tool'
          ? `### 工具：${e.tool.title}\n\n${JSON.stringify(e.tool, null, 2)}`
          : `## ${e.role}\n\n${e.text}`,
      )
      .join('\n\n---\n\n');
  }

  async exportChat() {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: this.host.cwd
        ? vscode.Uri.file(path.join(this.host.cwd, 'pi-conversation.md'))
        : undefined,
      filters: { Markdown: ['md'] },
    });
    if (!uri) return;
    const text = this.conversationText();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  }
}
