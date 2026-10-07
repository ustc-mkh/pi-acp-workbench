import type { AvailableCommand } from '@agentclientprotocol/sdk';

/** A viewport-level popup: the scrolling composer must never clip suggestions. */
export class SlashCommands {
  private commands: AvailableCommand[] = [];
  private matches: AvailableCommand[] = [];
  private status = 'disconnected';
  private index = 0;
  private dismissed = false;
  constructor(
    private input: HTMLTextAreaElement,
    private menu: HTMLElement,
    private selected: () => void,
  ) {
    document.body.append(menu);
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Agent 命令');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', menu.id);
    input.addEventListener('input', () => {
      this.index = 0;
      this.dismissed = false;
      this.render();
    });
    input.addEventListener('focus', () => {
      this.dismissed = false;
      this.render();
    });
    input.addEventListener('blur', () => this.hide());
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || menu.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.dismissed = true;
        this.hide();
        return;
      }
      if (!this.matches.length || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.index =
          (this.index + (event.key === 'ArrowDown' ? 1 : -1) + this.matches.length) %
          this.matches.length;
        this.highlight();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.choose(this.matches[this.index]);
      }
    });
    window.addEventListener('resize', () => this.position());
    input.closest('footer')?.addEventListener('scroll', () => this.position(), { passive: true });
    // Divider dragging and attachment growth also move the textarea without a window resize.
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => this.position()).observe(input.closest('footer') || input);
  }
  update(commands: AvailableCommand[], status: string) {
    this.commands = commands;
    this.status = status;
    this.render();
  }
  private hide() {
    this.menu.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
  private choose(command: AvailableCommand) {
    this.input.value = `/${command.name.replace(/^\//, '')} `;
    this.dismissed = true;
    this.hide();
    this.input.focus();
    this.hide();
    this.selected();
  }
  private render() {
    const query = this.input.value.match(/^\/([^\s]*)$/);
    if (!query || this.dismissed || document.activeElement !== this.input) {
      this.hide();
      return;
    }
    this.matches =
      this.status === 'ready'
        ? this.commands.filter((c) =>
            c.name.replace(/^\//, '').toLowerCase().startsWith(query[1].toLowerCase()),
          )
        : [];
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1));
    this.menu.replaceChildren();
    if (!this.matches.length) {
      const note = document.createElement('div');
      note.className = 'commands-empty';
      note.textContent =
        this.status !== 'ready'
          ? '请先连接会话并等待 Agent 就绪，再查看命令。'
          : !this.commands.length
            ? 'Agent 尚未提供命令列表；这里只显示 ACP 声明的命令。'
            : '没有匹配的 ACP 命令。';
      this.menu.append(note);
    }
    this.matches.forEach((command, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.id = `acp-command-${index}`;
      button.setAttribute('role', 'option');
      button.textContent = `/${command.name.replace(/^\//, '')} — ${command.description}`;
      button.onmousedown = (event) => event.preventDefault(); // Keep textarea focus until click inserts the command.
      button.onclick = () => this.choose(command);
      this.menu.append(button);
    });
    this.menu.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.position();
    this.highlight();
  }
  private highlight() {
    this.menu
      .querySelectorAll('button')
      .forEach((button, index) =>
        button.setAttribute('aria-selected', String(index === this.index)),
      );
    const active = this.menu.querySelector<HTMLElement>(`#acp-command-${this.index}`);
    if (active) {
      this.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }
  private position() {
    if (this.menu.hidden) return;
    const rect = this.input.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, rect.left)}px`;
    this.menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    this.menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.menu.style.maxHeight = `${Math.max(0, Math.min(260, rect.top - 14))}px`;
  }
}
