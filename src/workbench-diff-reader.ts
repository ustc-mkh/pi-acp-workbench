import type { WorkbenchClient } from './workbench-client';
import type { WorkbenchSession } from './workbench-session';
import type { UiCommand, WorkbenchUiMessage } from './workbench-ui';
import type { TurnDiff } from './workbench-protocol';

/** Bounded diff observation; only the host opens editor documents. */
export class WorkbenchDiffReader {
  private turnDiffCache = new Map<string, TurnDiff>();
  constructor(
    private client: WorkbenchClient,
    private selected: () => WorkbenchSession | undefined,
    private closed: () => boolean,
    private post: (message: WorkbenchUiMessage) => void,
    private openDiff?: (
      turn: string,
      files: { path: string; before: string; after: string }[],
    ) => Promise<void>,
  ) {}
  clear() {
    this.turnDiffCache.clear();
  }
  async openTurnDiff(message: Extract<UiCommand, { type: 'open_turn_diff' }>) {
    const selected = this.selected();
    if (
      !selected ||
      selected.id !== message.session ||
      !selected.view.entries.some((row) => row.turn === message.turn)
    )
      throw new Error('Turn is not in the confirmed view');
    if (!this.openDiff) throw new Error('Editor diff is unavailable');
    const files: { path: string; before: string; after: string }[] = [];
    let offset = 0;
    let used = 0;
    do {
      const page = await this.client.call({
        method: 'turn_diff',
        session: selected.id,
        turn: message.turn,
        offset,
      });
      for (const [i, file] of page.files.entries()) {
        const index = offset + i;
        if (message.file !== undefined && message.file !== index) continue;
        if (file.omitted && file.omitted !== 'Diff content can be loaded in bounded slices.')
          continue;
        const text: string[] = [];
        for (const after of [false, true]) {
          let position = 0;
          let value = '';
          do {
            const slice = await this.client.call({
              method: 'turn_diff_content',
              session: selected.id,
              turn: message.turn,
              file: index,
              after,
              offset: position,
            });
            used += Buffer.byteLength(slice.bytes);
            if (used > 4 * 1024 * 1024) throw new Error('Editor diff exceeds 4 MiB budget');
            value += slice.bytes;
            if (slice.next_offset == null) break;
            if (slice.next_offset <= position) throw new Error('Invalid diff cursor');
            position = slice.next_offset;
          } while (true);
          text.push(value);
        }
        files.push({ path: file.path, before: text[0], after: text[1] });
      }
      if (page.next_offset == null) break;
      if (page.next_offset <= offset || page.next_offset > 5000)
        throw new Error('Invalid diff page');
      offset = page.next_offset;
    } while (true);
    if (this.selected() !== selected || this.closed()) return;
    if (!files.length)
      throw new Error('No complete text snapshots available; review partial reasons in the card');
    await this.openDiff(message.turn, files);
  }
  async readTurnDiff(message: Extract<UiCommand, { type: 'read_turn_diff' }>) {
    const selected = this.selected();
    if (
      !selected ||
      selected.id !== message.session ||
      !selected.view.entries.some((row) => row.turn === message.turn)
    )
      throw new Error('Turn is not in the confirmed view');
    try {
      const diff = await this.client.call({
        method: 'turn_diff',
        session: selected.id,
        turn: message.turn,
        offset: message.offset,
      });
      if (this.selected() !== selected || this.closed()) return;
      const key = `${selected.id}:${message.turn}`;
      const previous = this.turnDiffCache.get(key);
      const start = message.offset ?? 0;
      if (start > 0 && (!previous || previous.files.length !== start))
        throw new Error('Diff page is out of order');
      const merged =
        start > 0 && previous ? { ...diff, files: [...previous.files, ...diff.files] } : diff;
      if (merged.files.length > 5000) throw new Error('Diff exceeds file budget');
      this.turnDiffCache.set(key, merged);
      while (this.turnDiffCache.size > 16)
        this.turnDiffCache.delete(this.turnDiffCache.keys().next().value!);
      if (this.selected() === selected && !this.closed())
        this.post({
          type: 'turn_diff',
          session: selected.id,
          turn: message.turn,
          offset: message.offset,
          diff,
        });
    } catch {
      if (this.selected() === selected && !this.closed())
        this.post({
          type: 'turn_diff_error',
          session: selected.id,
          turn: message.turn,
          error: message.automatic ? '' : 'Workspace diff unavailable',
        });
    }
  }
  async readTurnDiffContent(message: Extract<UiCommand, { type: 'read_turn_diff_content' }>) {
    const selected = this.selected();
    const diff = this.turnDiffCache.get(`${message.session}:${message.turn}`);
    if (
      !selected ||
      selected.id !== message.session ||
      !selected.view.entries.some((row) => row.turn === message.turn) ||
      !diff ||
      message.file >= diff.files.length
    )
      throw new Error('Diff file is not in the confirmed view');
    try {
      const content = await this.client.call({
        method: 'turn_diff_content',
        session: selected.id,
        turn: message.turn,
        file: message.file,
        after: message.after,
        offset: message.offset,
      });
      if (this.selected() === selected && !this.closed())
        this.post({
          type: 'turn_diff_content',
          session: selected.id,
          turn: message.turn,
          file: message.file,
          after: message.after,
          offset: message.offset,
          ...content,
        });
    } catch {
      if (this.selected() === selected && !this.closed())
        this.post({
          type: 'turn_diff_error',
          session: selected.id,
          turn: message.turn,
          error: 'Diff content unavailable',
        });
    }
  }
}
