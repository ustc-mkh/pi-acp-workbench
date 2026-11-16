import { element, button } from './workbench-elements';
import type { ImageAsset, ImageRef, SessionView } from '../src/workbench-protocol';
import type { UiCommand, WorkbenchUiMessage, WorkbenchUiState } from '../src/workbench-ui';

/** Owns archived image requests, byte budget and object URL lifetime. */
export class ImageView {
  private images = new Map<string, { asset: ImageAsset; url: string }>();
  private imageErrors = new Map<string, string>();
  private pendingImages = new Map<number, { image: string; session: string }>();
  private nextUiRequest = 0;
  private imageBytes = 0;
  constructor(
    private state: () => WorkbenchUiState | undefined,
    private send: (message: UiCommand) => void,
    private schedule: () => void,
  ) {}
  status(id: string) {
    return [
      this.images.get(id)?.url,
      this.imageErrors.get(id),
      [...this.pendingImages.values()].some((item) => item.image === id),
      this.pendingImages.size >= 4,
    ] as const;
  }
  retain(visible: Set<string>) {
    for (const [id, pending] of this.pendingImages)
      if (!visible.has(pending.image)) this.pendingImages.delete(id);
    for (const id of this.imageErrors.keys()) if (!visible.has(id)) this.imageErrors.delete(id);
  }
  clear() {
    for (const image of this.images.values()) URL.revokeObjectURL(image.url);
    this.images.clear();
    this.imageBytes = 0;
    this.imageErrors.clear();
    this.pendingImages.clear();
  }
  node(ref: ImageRef, session: SessionView['id']) {
    const box = element('figure'),
      cached = this.images.get(ref.id);
    if (cached) {
      this.images.delete(ref.id);
      this.images.set(ref.id, cached);
      const img = element('img');
      img.alt = 'Archived agent image';
      img.src = cached.url;
      box.append(img);
    } else {
      const load = button(
        [...this.pendingImages.values()].some((item) => item.image === ref.id)
          ? 'Loading image…'
          : 'Load archived image',
        () => {
          if (this.pendingImages.size >= 4) return;
          const request_id = ++this.nextUiRequest;
          this.pendingImages.set(request_id, { image: ref.id, session });
          this.send({ type: 'read_image', session, image: ref, request_id });
          this.schedule();
        },
        [...this.pendingImages.values()].some((item) => item.image === ref.id) ||
          this.pendingImages.size >= 4,
      );
      box.append(load);
    }
    box.append(
      element(
        'figcaption',
        `${ref.mime} · ${ref.bytes} bytes${this.imageErrors.has(ref.id) ? ' · ' + this.imageErrors.get(ref.id) : ''}`,
      ),
    );
    return box;
  }
  receive(raw: WorkbenchUiMessage) {
    const state = this.state();
    if (raw.type === 'image' && raw.session === state?.selected) {
      const asset = raw.asset,
        ref = (state?.view?.entries || []).find((row) => row.image?.id === asset.image.id)?.image;
      if (
        !ref ||
        ref.bytes !== asset.image.bytes ||
        ref.mime !== asset.image.mime ||
        ref.sha256 !== asset.image.sha256
      )
        return;
      const bytes = atob(asset.data);
      if (bytes.length !== ref.bytes || btoa(bytes) !== asset.data) throw new Error();
      if (!this.images.has(ref.id)) {
        while (this.imageBytes + ref.bytes > 32 * 1024 * 1024 && this.images.size) {
          const first = this.images.keys().next().value!;
          this.imageBytes -= this.images.get(first)!.asset.image.bytes;
          URL.revokeObjectURL(this.images.get(first)!.url);
          this.images.delete(first);
        }
        this.images.set(ref.id, {
          asset,
          url: URL.createObjectURL(
            new Blob([Uint8Array.from(bytes, (ch) => ch.charCodeAt(0))], { type: ref.mime }),
          ),
        });
        this.imageBytes += ref.bytes;
      }
      if (raw.request_id !== undefined) this.pendingImages.delete(raw.request_id);
      else
        for (const [request_id, pending] of this.pendingImages)
          if (pending.image === ref.id && pending.session === raw.session)
            this.pendingImages.delete(request_id);
      this.imageErrors.delete(ref.id);
      this.schedule();
    }
    if (raw.type === 'image_error' && raw.session === state?.selected) {
      if (raw.request_id !== undefined) this.pendingImages.delete(raw.request_id);
      else
        for (const [request_id, pending] of this.pendingImages)
          if (pending.image === raw.image && pending.session === raw.session)
            this.pendingImages.delete(request_id);
      this.imageErrors.set(raw.image, 'Archive unavailable');
      this.schedule();
    }
  }
}
