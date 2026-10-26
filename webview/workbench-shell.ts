/** Classic v1 presentation shell. Receives existing controls; owns no host/Agent state. */
export function decorateIcon(button: HTMLButtonElement, icon: string, label: string) {
  button.setAttribute('aria-label', label);
  button.title = label;
  button.classList.add('icon-button');
  const paths: Record<string, string> = {
    history: '',
    export: 'M8 2v9M4 7l4 4 4-4M3 11v3h10v-3',
    settings: 'M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M6 10v4',
    stats: 'M2 14h12M4 11V8M8 11V3M12 11V6',
    plus: 'M8 3v10M3 8h10',
    more: 'M3 8h.01M8 8h.01M13 8h.01',
    send: 'M3 7l5-5 5 5M8 2v12',
    attach: 'M6 8l4-4a2 2 0 0 1 3 3l-6 6a3 3 0 0 1-4-4l6-6',
    image: 'M2 3h12v10H2zM2 11l4-4 3 3 2-2 3 3M10 5h.01',
  };
  const glyphs: Record<string, string> = { history: '◷', export: '↧', plus: '＋' };
  if (glyphs[icon]) {
    button.textContent = glyphs[icon];
    return;
  }
  if (icon === 'settings' || icon === 'stats') {
    button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${icon === 'settings' ? 'M3 4h14M3 10h14M3 16h14M7 2v4M13 8v4M7 14v4' : 'M3 16h14M5 13V9M10 13V4M15 13V7'}"/></svg>`;
    return;
  }
  // Every path comes from this fixed product-owned table, never provider data.
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${paths[icon] || paths.more}"/></svg>`;
}
export function buildClassicShell(options: {
  root: HTMLElement;
  header: HTMLElement;
  harness: HTMLSelectElement;
  newSession: HTMLButtonElement;
  activity: HTMLButtonElement;
  toolbar: { node: HTMLButtonElement; icon: string; label: string }[];
  history: HTMLElement;
  status: HTMLElement;
  error: HTMLElement;
  management: HTMLElement;
  settings: HTMLElement;
  plan: HTMLElement;
  transcript: HTMLElement;
  interactions: HTMLElement;
  operations: HTMLElement;
  composer: HTMLFormElement;
  advanced: HTMLElement;
  historyOpen: boolean;
  onHistoryChange(open: boolean): void;
}) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const brand = el('div', 'brand'),
    logo = el('span', 'logo'),
    protocol = el('span', 'protocol');
  logo.id = 'harness-logo';
  logo.textContent = 'π';
  protocol.textContent = 'ACP';
  const more = options.advanced.querySelector('summary')!;
  more.textContent = 'ACP';
  more.className = 'protocol';
  brand.append(logo, options.harness, options.advanced);
  brand.title = '右键打开会话选项';
  brand.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    (options.advanced as HTMLDetailsElement).open = true;
  });
  brand.addEventListener('keydown', (event) => {
    if (event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      (options.advanced as HTMLDetailsElement).open = true;
    }
  });
  const toolbar = el('div', 'toolbar'),
    historyToggle = el('button');
  historyToggle.type = 'button';
  decorateIcon(historyToggle, 'history', '历史记录');
  historyToggle.id = 'history-toggle';
  historyToggle.setAttribute('aria-controls', 'history');
  const showHistory = (open: boolean) => {
    options.history.hidden = !open;
    historyToggle.setAttribute('aria-expanded', String(open));
    options.onHistoryChange(open);
  };
  historyToggle.onclick = () => showHistory(options.history.hidden);
  options.history.hidden = !options.historyOpen;
  historyToggle.setAttribute('aria-expanded', String(options.historyOpen));
  toolbar.append(historyToggle);
  for (const item of options.toolbar) {
    decorateIcon(item.node, item.icon, item.label);
    item.node.id =
      item.icon === 'settings'
        ? 'models-toggle'
        : item.icon === 'stats'
          ? 'statistics-toggle'
          : 'export';
    toolbar.append(item.node);
  }
  decorateIcon(options.newSession, 'plus', '新对话');
  options.newSession.id = 'new';
  toolbar.append(options.newSession);
  options.header.replaceChildren(brand, toolbar);
  const chat = el('div', 'chat-page'),
    connection = el('div');
  chat.id = 'chat-page';
  connection.id = 'connection';
  const dot = el('span', 'status-dot'),
    sessionTitle = el('span', 'session-number');
  sessionTitle.id = 'session-number';
  connection.append(dot, sessionTitle, options.status, options.activity);
  options.activity.id = 'toggle-activity';
  const area = el('div', 'transcript-area');
  area.append(options.transcript);
  const bottom = el('button', 'primary');
  bottom.id = 'bottom';
  bottom.type = 'button';
  bottom.textContent = '↓';
  bottom.setAttribute('aria-label', '回到最新消息');
  bottom.title = '回到最新消息';
  bottom.hidden = true;
  bottom.onclick = () => {
    options.transcript.scrollTop = options.transcript.scrollHeight;
    updateBottom();
  };
  const updateBottom = () => {
    bottom.hidden =
      !options.transcript.children.length ||
      options.transcript.scrollHeight -
        options.transcript.scrollTop -
        options.transcript.clientHeight <
        80;
  };
  options.transcript.addEventListener('scroll', updateBottom, { passive: true });
  area.append(bottom);
  const welcome = el('section');
  welcome.id = 'welcome';
  const hero = el('div', 'hero-icon'),
    heading = el('h1'),
    description = el('p'),
    start = el('button'),
    note = el('small');
  hero.textContent = 'π';
  heading.textContent = '从一个想法开始。';
  const harnessNote = el('span');
  harnessNote.textContent = '让 Pi 在你的工作区里协助你。';
  description.append('代码、推导、探索。', el('br'), harnessNote);
  start.type = 'button';
  start.textContent = '新建会话';
  start.onclick = () => options.newSession.click();
  note.textContent = '通过 ACP 连接本地 Agent';
  const demo = el('button');
  demo.id = 'demo';
  demo.type = 'button';
  demo.append('预览 Markdown 与公式 ', Object.assign(el('span'), { textContent: '↗' }));
  demo.onclick = () => options.root.dispatchEvent(new window.CustomEvent('workbench-preview'));
  welcome.append(hero, heading, description, start, demo, note);
  options.transcript.prepend(welcome);
  const footer = el('footer');
  const resizer = options.composer.querySelector('.composer-resize')!;
  resizer.id = 'composer-resizer';
  footer.append(options.composer);
  const diagnostics = el('details');
  diagnostics.id = 'diagnostics';
  const summary = el('summary');
  summary.textContent = '连接与操作诊断';
  diagnostics.append(summary, options.operations);
  options.advanced.append(diagnostics);
  chat.append(
    options.history,
    options.plan,
    connection,
    options.error,
    area,
    options.interactions,
    resizer,
    footer,
  );
  options.root.replaceChildren(options.header, chat, options.management);
  return {
    showHistory,
    updateBottom,
    update(view: {
      hasSession: boolean;
      title: string;
      status: string;
      busy: boolean;
      connected: boolean;
      harness: string;
      number?: number;
      retentionDays?: number;
      entries: number;
      hasActivity: boolean;
      preview?: boolean;
    }) {
      const glyph = view.harness === 'Pi' ? 'π' : view.harness === 'Codex' ? '>_' : 'C';
      logo.textContent = glyph;
      hero.textContent = glyph;
      welcome.hidden = view.entries > 0 || !!view.preview;
      start.hidden = view.hasSession;
      connection.hidden = !view.hasSession && !view.preview;
      harnessNote.textContent = `让 ${view.harness === 'Pi' ? 'Pi' : view.harness} 在你的工作区里协助你。`;
      sessionTitle.hidden = !view.hasSession || !!view.preview;
      sessionTitle.textContent = view.number ? '#' + String(view.number).padStart(3, '0') : '#—';
      options.status.textContent = view.preview
        ? '渲染预览 · 离线'
        : !view.connected || view.status === '正在加载模型与偏好…'
          ? view.status
          : '';
      options.activity.hidden = !view.hasActivity;
      sessionTitle.title = view.title;
      sessionTitle.classList.toggle('alive-long', view.retentionDays === 4);
      sessionTitle.classList.toggle('alive-short', view.retentionDays === 1);
      connection.dataset.status = view.busy ? 'busy' : view.connected ? 'ready' : 'disconnected';
      options.root.dataset.page =
        options.management.tagName === 'DETAILS' && (options.management as HTMLDetailsElement).open
          ? 'management'
          : 'chat';
      for (const item of options.toolbar) {
        if (item.icon === 'settings' || item.icon === 'stats')
          item.node.setAttribute(
            'aria-pressed',
            String(
              (options.management as HTMLDetailsElement).open &&
                options.management.dataset.page ===
                  (item.icon === 'settings' ? 'models' : 'statistics'),
            ),
          );
      }
      start.disabled = options.newSession.disabled;
      updateBottom();
    },
  };
}
