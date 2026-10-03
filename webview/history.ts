import type { ChatState, UiMessage } from '../src/shared';
const trash = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M7 5.5V3h6v2.5M5 5.5l.8 11h8.4l.8-11M8 8v5.5M12 8v5.5"/></svg>';
const chat = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 3v-3H3V4.5a1 1 0 0 1 1-1Z"/></svg>';

/** Keep rows and the scroll position stable while token updates stream in. */
export class HistoryList {
  private rows = new Map<string, { row: HTMLElement; remove: HTMLButtonElement; open: HTMLButtonElement; status: HTMLElement }>();
  constructor(private container: HTMLElement, private send: (message: UiMessage) => void, private onOpen: () => void) {}
  update(state: Pick<ChatState, 'history' | 'sessionId' | 'status'>) {
    const ids = new Set(state.history.map(item => item.id));
    for (const [id, entry] of this.rows) if (!ids.has(id)) { entry.row.remove(); this.rows.delete(id); }
    if (!state.history.length) { this.container.textContent = '还没有保存的会话。'; return; }
    if (!this.rows.size) this.container.replaceChildren();
    state.history.forEach((item, index) => {
      let entry = this.rows.get(item.id);
      if (!entry) {
        const row = document.createElement('div'); row.className = 'history-row'; row.dataset.id = item.id;
        const remove = document.createElement('button'); remove.className = 'history-delete'; remove.type = 'button'; remove.innerHTML = trash;
        remove.dataset.tooltip = '删除此会话的历史记录';
        remove.onclick = () => this.send({ type: 'deleteHistory', id: item.id });
        const status = document.createElement('span'); status.className = 'session-indicator'; status.role = 'img'; status.innerHTML = chat;
        const open = document.createElement('button'); open.className = 'history-open'; open.type = 'button';
        open.onclick = () => { this.send({ type: 'resume', id: item.id }); this.onOpen(); };
        row.append(remove, status, open); entry = { row, remove, open, status }; this.rows.set(item.id, entry);
      }
      const current = state.sessionId === item.id, running = current && state.status === 'busy';
      entry.remove.setAttribute('aria-label', `删除会话：${item.title}`);
      entry.status.classList.toggle('running', running);
      entry.status.setAttribute('aria-label', running ? '正在输出' : '未在输出');
      entry.status.dataset.tooltip = running ? '正在输出' : '未在输出';
      entry.row.classList.toggle('current', current);
      if (current) entry.open.setAttribute('aria-current', 'true'); else entry.open.removeAttribute('aria-current');
      if (entry.open.textContent !== item.title) entry.open.textContent = item.title;
      entry.open.dataset.tooltip = `${item.title}\n${item.cwd}\n${new Date(item.updated).toLocaleString()}`;
      entry.open.disabled = state.status === 'busy' || state.status === 'connecting';
      if (this.container.children[index] !== entry.row) this.container.insertBefore(entry.row, this.container.children[index] || null);
    });
  }
}
