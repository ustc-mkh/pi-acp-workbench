/** Presentation-only controls over the exact, advertised ACP select options. */
export class ModelControls {
  readonly root = document.createElement('div');
  private trigger = document.createElement('button');
  private panel = document.createElement('section');
  private fast = document.createElement('button');
  private level = document.createElement('span');
  private model = document.createElement('button');
  private reset = document.createElement('button');
  private range = document.createElement('input');
  private dots = document.createElement('div');
  private native = document.createElement('div');
  private extra = document.createElement('div');
  private picker = document.createElement('div');
  private search = document.createElement('input');
  private options = document.createElement('div');
  private modelSelect?: HTMLSelectElement;
  private thinkingSelect?: HTMLSelectElement;
  private fastSelect?: HTMLSelectElement;
  private openingThinking?: string;
  private scope = '';
  private pickerOpen = false;
  private pendingChoice?: { key: string; value: string; failure?: string };
  private lastFailure?: string;
  get busy() {
    return Boolean(this.pendingChoice);
  }
  constructor(private changed: () => void = () => {}) {
    this.root.className = 'model-controls';
    this.trigger.type = this.fast.type = this.model.type = this.reset.type = 'button';
    this.trigger.className = 'model-controls-trigger';
    this.trigger.setAttribute('aria-label', '模型、思考和 Fast 设置');
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.onclick = () => this.show(this.panel.hidden);
    this.panel.className = 'model-controls-popover';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', '模型与思考设置');
    this.panel.hidden = true;
    const heading = document.createElement('div');
    heading.className = 'model-controls-heading';
    this.fast.className = 'model-fast-toggle';
    this.fast.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg>';
    this.fast.setAttribute('aria-label', 'Fast Mode');
    this.fast.onclick = () => {
      const select = this.fastSelect;
      if (!select || select.disabled) return;
      const enabled = this.enabledFastValue();
      const value =
        select.value === enabled
          ? [...select.options].find((o) => o.value !== enabled)?.value
          : enabled;
      if (value !== undefined) this.change(select, value);
    };
    const center = document.createElement('div');
    center.className = 'model-controls-center';
    this.level.className = 'model-thinking-label';
    this.model.className = 'model-picker-trigger';
    this.model.onclick = () => {
      this.pickerOpen = !this.pickerOpen;
      this.renderPicker();
      if (this.pickerOpen) this.search.focus();
    };
    center.append(this.level, this.model);
    this.reset.className = 'model-thinking-reset';
    this.reset.setAttribute('aria-label', '恢复打开面板时的思考强度');
    this.reset.title = '恢复本次打开面板时的思考强度';
    this.reset.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9a9 9 0 1 1 0 6M4 3v6h6"/></svg>';
    this.reset.onclick = () => {
      const select = this.thinkingSelect;
      if (
        select &&
        !select.disabled &&
        [...select.options].some((o) => o.value === this.openingThinking)
      )
        this.change(select, this.openingThinking!);
    };
    heading.append(this.fast, center, this.reset);
    const track = document.createElement('div');
    track.className = 'model-thinking-track';
    this.range.type = 'range';
    this.range.min = '0';
    this.range.step = '1';
    this.range.setAttribute('aria-label', '思考强度');
    this.range.oninput = () => this.updateLevel(Number(this.range.value));
    this.range.onchange = () => {
      const select = this.thinkingSelect,
        option = select?.options[Number(this.range.value)];
      if (select && option && !select.disabled) this.change(select, option.value);
    };
    this.dots.className = 'model-thinking-dots';
    this.dots.setAttribute('aria-hidden', 'true');
    track.append(this.range, this.dots);
    this.native.className = 'model-control-native';
    this.extra.className = 'model-controls-extra';
    this.picker.className = 'model-picker';
    this.search.type = 'search';
    this.search.placeholder = '搜索模型';
    this.search.setAttribute('aria-label', '搜索可用模型');
    this.search.oninput = () => this.renderPicker();
    this.options.className = 'model-picker-options';
    this.options.setAttribute('role', 'group');
    this.options.setAttribute('aria-label', '可用模型');
    this.picker.append(this.search, this.options);
    this.panel.append(heading, track, this.picker, this.extra, this.native);
    this.root.append(this.trigger);
    document.body.append(this.panel);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (!this.panel.hidden && !this.panel.contains(target) && !this.root.contains(target))
        this.show(false);
    });
    document.addEventListener('focusin', (event) => {
      const target = event.target as Node;
      if (!this.panel.hidden && !this.panel.contains(target) && !this.root.contains(target))
        this.show(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.panel.hidden) {
        event.preventDefault();
        this.show(false);
        this.trigger.focus();
      }
    });
    window.addEventListener('resize', () => this.position());
  }
  private change(select: HTMLSelectElement, value: string) {
    if (select.value === value || this.pendingChoice) return;
    this.pendingChoice = {
      key: select.getAttribute('aria-label') || '',
      value,
      failure: this.lastFailure,
    };
    this.syncDisabled();
    this.changed();
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  private enabledFastValue() {
    const options = [...(this.fastSelect?.options || [])];
    return (
      options.find(
        (o) =>
          /^(on|true|enabled|enable|fast)$/i.test(o.value) ||
          /^(on|enabled|开启|启用)$/i.test(o.textContent || ''),
      )?.value ?? options[1]?.value
    );
  }
  private label(option?: HTMLOptionElement) {
    const text = option?.textContent || '';
    const names: Record<string, string> = {
      none: '关闭',
      off: '关闭',
      minimal: '最低',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '超高',
      max: '最高',
    };
    return names[text.toLowerCase()] || names[option?.value.toLowerCase() || ''] || text;
  }
  private updateLevel(index: number) {
    const options = this.thinkingSelect?.options;
    this.level.textContent = options?.length ? this.label(options[index]) : '默认';
    this.range.setAttribute('aria-valuetext', this.level.textContent);
    const progress = options && options.length > 1 ? (100 * index) / (options.length - 1) : 0;
    this.range.style.setProperty('--thinking-progress', progress + '%');
  }
  update(scope: string, selects: HTMLSelectElement[], error?: string) {
    if (scope !== this.scope) {
      this.scope = scope;
      if (this.pendingChoice) {
        this.pendingChoice = undefined;
        this.changed();
      }
      this.show(false);
    }
    if (
      this.pendingChoice &&
      ((error && error !== this.pendingChoice.failure) ||
        selects.some(
          (s) =>
            s.getAttribute('aria-label') === this.pendingChoice!.key &&
            s.value === this.pendingChoice!.value,
        ))
    ) {
      this.pendingChoice = undefined;
      this.changed();
    }
    this.lastFailure = error;
    this.modelSelect = selects.find((s) => s.getAttribute('aria-label') === 'model');
    this.thinkingSelect = selects.find((s) => s.dataset.controlKind === 'thinking');
    this.fastSelect = selects.find((s) => s.dataset.controlKind === 'fast');
    this.native.replaceChildren();
    this.extra.replaceChildren();
    for (const select of selects) {
      select.classList.remove('selector-native');
      if ([this.modelSelect, this.thinkingSelect, this.fastSelect].includes(select)) {
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        this.native.append(select);
      } else {
        select.tabIndex = 0;
        select.removeAttribute('aria-hidden');
        const label = document.createElement('label');
        label.append(select.getAttribute('aria-label') || '设置', select);
        this.extra.append(label);
      }
    }
    this.trigger.disabled = selects.length === 0;
    const name = this.modelSelect?.selectedOptions[0]?.textContent || '模型设置';
    const thinking = this.thinkingSelect;
    const fastOn = !!this.fastSelect && this.fastSelect.value === this.enabledFastValue();
    this.trigger.textContent = `${name}${thinking ? ' · ' + this.label(thinking.selectedOptions[0]) : ''}${fastOn ? ' ⚡' : ''} ⌃`;
    this.model.textContent = name + ' ›';
    this.model.disabled = !this.modelSelect || this.modelSelect.disabled;
    this.fast.disabled =
      !this.fastSelect || this.fastSelect.disabled || this.fastSelect.options.length < 2;
    this.fast.setAttribute('aria-pressed', String(fastOn));
    this.fast.title = this.fastSelect
      ? 'Fast Mode · ' + this.fastSelect.selectedOptions[0]?.textContent
      : '当前模型未提供 Fast Mode';
    this.range.max = String(Math.max(0, (thinking?.options.length || 1) - 1));
    this.range.value = String(Math.max(0, thinking?.selectedIndex || 0));
    this.range.disabled = !thinking || thinking.disabled || thinking.options.length < 2;
    this.reset.disabled = !thinking || thinking.disabled || this.openingThinking === undefined;
    this.updateLevel(Number(this.range.value));
    this.dots.replaceChildren(
      ...Array.from({ length: thinking?.options.length || 1 }, () => document.createElement('i')),
    );
    this.syncDisabled();
    this.renderPicker();
    this.position();
  }
  private syncDisabled() {
    this.panel.setAttribute('aria-busy', String(this.busy));
    this.fast.disabled =
      this.busy ||
      !this.fastSelect ||
      this.fastSelect.disabled ||
      this.fastSelect.options.length < 2;
    this.range.disabled =
      this.busy ||
      !this.thinkingSelect ||
      this.thinkingSelect.disabled ||
      this.thinkingSelect.options.length < 2;
    this.model.disabled = this.busy || !this.modelSelect || this.modelSelect.disabled;
    this.reset.disabled =
      this.busy ||
      !this.thinkingSelect ||
      this.thinkingSelect.disabled ||
      this.openingThinking === undefined;
    this.extra.inert = this.busy;
  }
  private renderPicker() {
    this.picker.hidden = !this.pickerOpen;
    this.model.setAttribute('aria-expanded', String(this.pickerOpen));
    this.options.replaceChildren();
    for (const option of this.modelSelect?.options || []) {
      if (
        !option.value ||
        !(option.textContent || '').toLowerCase().includes(this.search.value.toLowerCase())
      )
        continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.textContent;
      button.setAttribute('aria-pressed', String(option.selected));
      button.disabled = !!this.modelSelect?.disabled;
      button.onclick = () => {
        this.change(this.modelSelect!, option.value);
        this.pickerOpen = false;
        this.renderPicker();
        this.model.focus();
      };
      this.options.append(button);
    }
    this.position();
  }
  show(open: boolean) {
    if (open && this.panel.hidden) this.openingThinking = this.thinkingSelect?.value;
    this.panel.hidden = !open;
    this.trigger.setAttribute('aria-expanded', String(open));
    this.reset.disabled =
      this.busy ||
      !this.thinkingSelect ||
      !!this.thinkingSelect.disabled ||
      this.openingThinking === undefined;
    if (!open) {
      this.pickerOpen = false;
      this.search.value = '';
      this.picker.hidden = true;
    }
    this.position();
    if (open) {
      if (!this.range.disabled) this.range.focus();
      else if (!this.model.disabled) this.model.focus();
    }
  }
  private position() {
    if (this.panel.hidden) return;
    const anchor = this.trigger.getBoundingClientRect();
    const width = Math.min(304, Math.max(0, window.innerWidth - 24));
    this.panel.style.width = width + 'px';
    this.panel.style.left =
      Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) + 'px';
    this.panel.style.top =
      Math.max(12, anchor.top - this.panel.getBoundingClientRect().height - 10) + 'px';
  }
}
