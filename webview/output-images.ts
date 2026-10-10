import type * as acp from '@agentclientprotocol/sdk';
import type { HarnessId } from '../src/harness';
import type { UiMessage, OutputImageReply } from '../src/shared';
import { MAX_ATTACHMENT_IMAGE_BYTES, type PastedImage } from '../src/images';
import { imagePreview } from './image-paste';

export function inlineImageData(source: string): PastedImage | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (match && match[2].length <= 4 * 1024 * 1024 && match[2].length % 4 === 0)
    return { name: '输出图片', mimeType: match[1], data: match[2] };
}
export function imageMarkerSource(source: string): boolean {
  if (/^data:/i.test(source)) return !!inlineImageData(source);
  return (
    !!source &&
    source.length <= 4096 &&
    !/[\x00-\x1f]/.test(source) &&
    (!/^(?:[a-z][\w+.-]*:|\/\/)/i.test(source) ||
      /^file:/i.test(source) ||
      /^[a-z]:[\\/]/i.test(source))
  );
}
export function contentImage(block: acp.ContentBlock, name = '输出图片') {
  if (block.type === 'image') return imagePreview(block.mimeType, block.data, name);
  if (block.type === 'resource' && 'blob' in block.resource && block.resource.mimeType)
    return imagePreview(block.resource.mimeType, block.resource.blob, name);
}
function replaceImage(node: HTMLElement, image: PastedImage, changed?: () => void) {
  const img = imagePreview(image.mimeType, image.data, node.textContent || image.name);
  if (!img) return;
  img.onload = () => changed?.();
  img.onerror = () => {
    img.replaceWith(node);
    node.textContent = '[图片无法解码]';
    changed?.();
  };
  node.replaceWith(img);
}
export function hydrateInlineImages(root: HTMLElement) {
  for (const node of root.querySelectorAll<HTMLElement>('[data-image-source]')) {
    const image = inlineImageData(node.dataset.imageSource!);
    if (image) replaceImage(node, image);
  }
}

/** Bounded, scope-specific local image requests; never fetch remote URLs in the webview. */
export class OutputImages {
  private serial = 0;
  private scope = '';
  private harness: HarnessId = 'pi';
  private sessionId?: string;
  private cache = new Map<string, PastedImage>();
  private bytes = 0;
  private pending = new Map<string, { id?: string; nodes: Set<HTMLElement> }>();
  constructor(
    private send: (message: UiMessage) => void,
    private changed: () => void = () => {},
  ) {}
  setScope(harness: HarnessId, sessionId?: string) {
    const scope = JSON.stringify([harness, sessionId]);
    if (scope === this.scope) return;
    this.scope = scope;
    this.harness = harness;
    this.sessionId = sessionId;
    this.cache.clear();
    this.pending.clear();
    this.bytes = 0;
  }
  hydrate = (root: HTMLElement) => {
    for (const image of root.querySelectorAll<HTMLImageElement>('.pasted-image'))
      image.addEventListener('load', this.changed);
    for (const node of root.querySelectorAll<HTMLElement>('[data-image-source]')) {
      const source = node.dataset.imageSource!;
      const inline = inlineImageData(source);
      if (inline) replaceImage(node, inline, this.changed);
      else if (imageMarkerSource(source)) this.load(source, node);
    }
  };
  private load(source: string, node: HTMLElement) {
    const cached = this.cache.get(source);
    if (cached) {
      replaceImage(node, cached, this.changed);
      return;
    }
    if (!this.pending.has(source) && this.pending.size >= 32) {
      node.textContent = '[图片数量过多]';
      return;
    }
    const request = this.pending.get(source) || { nodes: new Set<HTMLElement>() };
    if (request.nodes.size >= 32) request.nodes.delete(request.nodes.values().next().value!);
    request.nodes.add(node);
    this.pending.set(source, request);
    this.pump();
  }
  private pump() {
    let active = [...this.pending.values()].filter((r) => r.id).length;
    for (const [source, request] of this.pending) {
      if (active >= 4) break;
      if (request.id) continue;
      request.id = `output-image-${++this.serial}`;
      active++;
      this.send({
        type: 'readOutputImage',
        id: request.id,
        url: source,
        harness: this.harness,
        sessionId: this.sessionId,
      });
    }
  }
  receive(reply: OutputImageReply) {
    const found = [...this.pending].find(([, request]) => request.id === reply.id);
    if (!found) return;
    const [source, request] = found;
    this.pending.delete(source);
    const image = reply.image;
    if (image && imagePreview(image.mimeType, image.data, image.name)) {
      const size = image.data.length;
      while (
        this.cache.size &&
        (this.bytes + size > MAX_ATTACHMENT_IMAGE_BYTES || this.cache.size >= 64)
      ) {
        const key = this.cache.keys().next().value!;
        this.bytes -= this.cache.get(key)!.data.length;
        this.cache.delete(key);
      }
      if (size <= MAX_ATTACHMENT_IMAGE_BYTES) {
        this.cache.set(source, image);
        this.bytes += size;
      }
      for (const node of request.nodes) replaceImage(node, image, this.changed);
    } else
      for (const node of request.nodes) {
        node.textContent = '[图片不可用，点击重试]';
        node.setAttribute('role', 'button');
        node.tabIndex = 0;
        node.onclick = () => this.load(source, node);
        node.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.load(source, node);
          }
        };
      }
    this.pump();
  }
}
