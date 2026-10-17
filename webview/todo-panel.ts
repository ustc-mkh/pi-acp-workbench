import type * as acp from '@agentclientprotocol/sdk';

/** Pinned above the transcript, below history; the transcript alone scrolls. */
export class TodoPanel {
  private details = document.createElement('details');
  private summary = document.createElement('summary');
  private list = document.createElement('ul');
  private signature = '';
  constructor(
    private host: HTMLElement,
    collapsed = false,
    onCollapse?: (collapsed: boolean) => void,
  ) {
    host.classList.add('todo-panel');
    host.setAttribute('aria-label', '待办清单');
    this.details.open = !collapsed;
    this.details.ontoggle = () => onCollapse?.(!this.details.open);
    this.list.className = 'todo-list';
    this.list.setAttribute('aria-label', '待办事项');
    this.list.tabIndex = 0;
    this.details.append(this.summary, this.list);
    host.replaceChildren(this.details);
    host.hidden = true;
  }
  update(entries: acp.PlanEntry[], sessionId?: string) {
    const signature = JSON.stringify([sessionId, entries]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.host.hidden = !entries.length;
    this.summary.textContent = `待办清单 · ${entries.filter((e) => e.status === 'completed').length}/${entries.length}`;
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(
      ...entries.map((entry) => {
        const row = document.createElement('li');
        row.className = `todo-item ${entry.status}`;
        const status =
          entry.status === 'completed'
            ? '已完成'
            : entry.status === 'in_progress'
              ? '进行中'
              : '待处理';
        row.title = `${status} · ${entry.content}`;
        const circle = document.createElement('span');
        circle.className = 'todo-circle';
        circle.setAttribute('role', 'img');
        circle.setAttribute('aria-label', status);
        circle.textContent = entry.status === 'completed' ? '✓' : '';
        const label = document.createElement('span');
        label.className = 'todo-label';
        label.textContent = entry.content;
        row.append(circle, label);
        return row;
      }),
    );
    this.list.scrollTop = scroll;
  }
}
