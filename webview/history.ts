import type { ChatState, UiMessage } from '../src/shared';
import { sessionLabel } from '../src/session-numbers';
import { HARNESSES } from '../src/harness';
const trash =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M7 5.5V3h6v2.5M5 5.5l.8 11h8.4l.8-11M8 8v5.5M12 8v5.5"/></svg>';
const chat =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 3v-3H3V4.5a1 1 0 0 1 1-1Z"/></svg>';

/** Keep rows and the scroll position stable while token updates stream in. */
export class HistoryList {
  private state?: Pick<ChatState, 'history' | 'sessionId' | 'status'>;
  private more = document.createElement('button');
  private less = document.createElement('button');
  private limit: 4 | 10 | 16;
  private rows = new Map<
    string,
    {
      row: HTMLElement;
      remove: HTMLButtonElement;
      open: HTMLButtonElement;
      status: HTMLElement;
      number: HTMLElement;
      harness: HTMLElement;
    }
  >();
  constructor(
    private container: HTMLElement,
    private send: (message: UiMessage) => void,
    initialLimit: number | boolean = 4,
    private onExpand: (limit: number) => void = () => {},
    private onClose: () => void = () => {},
  ) {
    // Migrate the previously persisted 20-row tier to the new 16-row maximum.
    this.limit =
      initialLimit === 16 || initialLimit === 20
        ? 16
        : initialLimit === 10 || initialLimit === true
          ? 10
          : 4;
    const controls = document.createElement('div');
    controls.className = 'history-controls';
    for (const [button, className, arrow] of [
      [this.less, 'history-less', 'M4 10l4-4 4 4'],
      [this.more, 'history-more', 'M4 6l4 4 4-4'],
    ] as const) {
      button.type = 'button';
      button.className = `${className} circle-button`;
      button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${arrow}"/></svg>`;
      controls.append(button);
    }
    const resize = (limit: 4 | 10 | 16) => {
      this.limit = limit;
      this.onExpand(limit);
      if (this.state) this.update(this.state);
    };
    this.more.onclick = () => {
      if (this.limit < 16) resize(this.limit === 4 ? 10 : 16);
    };
    this.less.onclick = () => {
      if (this.limit === 4) this.onClose();
      else resize(this.limit === 16 ? 10 : 4);
    };
    this.container.after(controls);
  }
  update(state: Pick<ChatState, 'history' | 'sessionId' | 'status'>) {
    this.state = state;
    const visible = state.history.slice(0, this.limit);
    this.more.disabled = this.limit === 16 || state.history.length <= this.limit;
    const moreLabel =
      this.limit === 16 ? '最多显示 16 条会话' : `展开至 ${this.limit === 4 ? 10 : 16} 条会话`;
    const lessLabel =
      this.limit === 4 ? '关闭历史会话' : `收回至 ${this.limit === 16 ? 10 : 4} 条会话`;
    this.more.setAttribute('aria-label', moreLabel);
    this.less.setAttribute('aria-label', lessLabel);
    this.more.dataset.tooltip = moreLabel;
    this.less.dataset.tooltip = lessLabel;
    this.more.setAttribute('aria-expanded', String(this.limit > 4));
    this.container.classList.toggle('expanded', this.limit > 4);
    const ids = new Set(visible.map((item) => item.id));
    for (const [id, entry] of this.rows)
      if (!ids.has(id)) {
        entry.row.remove();
        this.rows.delete(id);
      }
    if (!state.history.length) {
      this.container.textContent = '还没有保存的会话。';
      return;
    }
    if (!this.rows.size) this.container.replaceChildren();
    visible.forEach((item, index) => {
      let entry = this.rows.get(item.id);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.dataset.id = item.id;
        const remove = document.createElement('button');
        remove.className = 'history-delete';
        remove.type = 'button';
        remove.innerHTML = trash;
        remove.onclick = () => this.send({ type: 'deleteHistory', id: item.id });
        const status = document.createElement('span');
        status.className = 'session-indicator';
        status.role = 'img';
        status.innerHTML = chat;
        const open = document.createElement('button');
        open.className = 'history-open';
        open.type = 'button';
        open.onclick = () => {
          this.send({ type: 'resume', id: item.id });
        };
        const number = document.createElement('span');
        number.className = 'session-number';
        const harness = document.createElement('span');
        harness.className = 'history-harness';
        row.append(status, number, harness, open, remove);
        entry = { row, remove, open, status, number, harness };
        this.rows.set(item.id, entry);
      }
      const current = state.sessionId === item.id,
        running = item.busy === true || (current && state.status === 'busy');
      const profile = HARNESSES[item.harness || 'pi'];
      entry.harness.textContent = profile?.name || '未知 Harness';
      entry.harness.hidden = !item.harness || item.harness === 'pi';
      const label = sessionLabel(item.sessionNumber, item.id);
      entry.number.textContent = label;
      entry.open.setAttribute('aria-label', `${label} ${item.title}`);
      entry.remove.setAttribute('aria-label', `删除会话：${label} ${item.title}`);
      entry.status.classList.toggle('running', running);
      entry.status.setAttribute('aria-label', running ? '正在输出' : '未在输出');
      entry.row.classList.toggle('current', current);
      if (current) entry.open.setAttribute('aria-current', 'true');
      else entry.open.removeAttribute('aria-current');
      if (entry.open.textContent !== item.title) entry.open.textContent = item.title;
      entry.open.disabled = state.status === 'connecting';
      if (this.container.children[index] !== entry.row)
        this.container.insertBefore(entry.row, this.container.children[index] || null);
    });
  }
}
