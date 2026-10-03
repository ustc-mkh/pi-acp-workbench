import { createRenderer } from './markdown';
import type { ChatState, Entry, UiMessage } from '../src/shared';
declare function acquireVsCodeApi(): { postMessage(message: UiMessage): void; getState(): { draft?: string } | undefined; setState(state: { draft: string }): void };
const vscode = acquireVsCodeApi();
const renderMarkdown = createRenderer(window);
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header><div class="brand"><span class="logo">π</span><span>Pi <b>Workbench</b></span><span class="protocol">ACP</span></div><div class="toolbar"><button id="history-toggle" title="历史记录" aria-label="历史记录">◷</button><button id="export" title="导出 Markdown" aria-label="导出 Markdown">↧</button><button id="new" title="新对话" aria-label="新对话">＋</button></div></header>
<section id="history" hidden><div class="section-label">最近会话 <button id="clear-history">清除本地历史</button></div><div id="history-items"></div></section>
<div id="connection"><span class="status-dot"></span><span id="status" role="status"></span><button id="connect">连接</button><button id="login">登录</button><button id="logs" title="查看日志">日志</button></div>
<div id="error" role="alert" hidden></div>
<main id="transcript" aria-label="对话记录" tabindex="0"><section id="welcome"><div class="hero-icon">π</div><h1>从一个想法开始。</h1><p>代码、推导、探索。<br>让 Pi 在你的工作区里协助你。</p><button id="demo">预览 Markdown 与公式 <span>↗</span></button><small>通过 ACP 连接本地 Agent</small></section><div id="messages"></div><div id="working" hidden><span class="pulse">●</span> Pi 正在处理…</div></main>
<button id="bottom" hidden>↓ 回到最新消息</button>
<section id="plan" aria-label="执行计划" hidden></section><section id="permissions" aria-label="操作授权" aria-live="polite"></section>
<footer><div id="attachments"></div><div class="composer"><textarea id="input" aria-label="向 Pi 发送消息" placeholder="描述任务，或输入 / 查看命令…" rows="3"></textarea><div id="commands" hidden></div><div class="composer-tools"><button id="attach" title="添加当前编辑器的选区或文件">＋ 上下文</button><span id="hint">Enter 发送 · Shift+Enter 换行</span><button id="stop" hidden>■ 停止</button><button id="send" class="primary" aria-label="发送消息">↑</button></div></div><div class="session-bar"><div id="selectors"></div><span id="usage"></span></div><div class="local-note">本地 Agent 可执行命令与修改文件 · 按需显示授权</div></footer>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = el<HTMLTextAreaElement>('input');
input.value = vscode.getState()?.draft || '';
const send = (message: UiMessage) => vscode.postMessage(message);
let state: ChatState | undefined;
let followBottom = true;
let sending = false;
let paintPending = false;
const cache = new Map<string, { signature: string; node: HTMLElement }>();
const button = (text: string, action: () => void, className?: string) => {
  const b = document.createElement('button'); b.textContent = text; b.type = 'button';
  if (className) b.className = className; b.addEventListener('click', action); return b;
};
function submit() {
  if (!input.value.trim() || state?.status !== 'ready' || sending) return;
  sending = true; send({ type: 'send', text: input.value });
}
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
});
input.addEventListener('input', () => { vscode.setState({ draft: input.value }); commandMenu(); updateSend(); });
el('send').onclick = submit;
el('stop').onclick = () => send({ type: 'cancel' });
el('connect').onclick = () => send({ type: 'connect' });
el('new').onclick = () => send({ type: 'new' });
el('attach').onclick = () => send({ type: 'attach' });
el('login').onclick = () => send({ type: 'login' });
el('logs').onclick = () => send({ type: 'logs' });
el('export').onclick = () => send({ type: 'export' });
el('demo').onclick = () => send({ type: 'preview' });
el('clear-history').onclick = () => send({ type: 'clearHistory' });
el('history-toggle').onclick = () => { el('history').hidden = !el('history').hidden; };
el('bottom').onclick = () => { followBottom = true; el('transcript').scrollTop = el('transcript').scrollHeight; el('bottom').hidden = true; };
el('transcript').addEventListener('scroll', () => {
  const t = el('transcript'); followBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  el('bottom').hidden = followBottom;
});
app.addEventListener('click', async event => {
  const target = (event.target as Element).closest('a, .copy-code');
  if (!target) return;
  event.preventDefault();
  if (target.matches('a')) {
    const url = target.getAttribute('href') || '';
    if (url.startsWith('#')) { try { document.getElementById(decodeURIComponent(url.slice(1)))?.scrollIntoView(); } catch { /* malformed anchor */ } }
    else send({ type: 'open', url });
  }
  else {
    try { await navigator.clipboard.writeText(target.parentElement?.querySelector('code')?.textContent || ''); target.textContent = '已复制'; }
    catch { target.textContent = '复制失败'; }
    setTimeout(() => { target.textContent = '复制'; }, 1500);
  }
});
function updateSend() { el<HTMLButtonElement>('send').disabled = state?.status !== 'ready' || !input.value.trim() || sending; }
function commandMenu() {
  const menu = el('commands'); menu.replaceChildren();
  const match = input.value.match(/^\/([^\s]*)$/);
  const commands = match ? state?.commands.filter(c => c.name.startsWith(match[1])).slice(0, 8) || [] : [];
  menu.hidden = !commands.length;
  for (const command of commands) {
    const b = button(`/${command.name} — ${command.description}`, () => { input.value = `/${command.name} `; input.focus(); menu.hidden = true; vscode.setState({ draft: input.value }); updateSend(); });
    menu.append(b);
  }
}
function contentNode(entry: Entry): HTMLElement {
  const node = document.createElement(entry.role === 'tool' || entry.role === 'thought' ? 'details' : 'article');
  node.className = `message ${entry.role}`;
  if (entry.role === 'tool') {
    const summary = document.createElement('summary');
    const labels: Record<string, string> = { pending: '等待', in_progress: '执行中', completed: '完成', failed: '失败' };
    summary.textContent = `${entry.tool.status === 'completed' ? '✓' : entry.tool.status === 'failed' ? '×' : '◇'} ${entry.tool.title}`;
    const badge = document.createElement('span'); badge.className = `badge ${entry.tool.status}`; badge.textContent = labels[entry.tool.status || 'pending']; summary.append(badge); node.append(summary);
    const body = document.createElement('div'); body.className = 'tool-body';
    for (const location of entry.tool.locations || []) body.append(button(`${location.path}${location.line ? ':' + location.line : ''}`, () => send({ type: 'open', url: location.path, line: location.line ?? undefined }), 'file-link'));
    (entry.tool.content || []).forEach((content, index) => {
      if (content.type === 'diff') {
        body.append(button(`查看修改 · ${content.path}`, () => send({ type: 'diff', id: entry.id, index }), 'diff-link'));
        const before = document.createElement('pre'), after = document.createElement('pre');
        before.className = 'diff-before'; after.className = 'diff-after';
        before.textContent = (content.oldText || '').slice(0, 4000); after.textContent = content.newText.slice(0, 4000);
        body.append(before, after);
      } else if (content.type === 'content') {
        const text = content.content.type === 'text' ? content.content.text : `[${content.content.type}]`;
        const c = document.createElement('div'); c.className = 'markdown'; c.innerHTML = renderMarkdown(text); body.append(c);
      } else { const p = document.createElement('p'); p.textContent = `终端 ${content.terminalId}`; body.append(p); }
    });
    if (entry.tool.rawInput != null || entry.tool.rawOutput != null) {
      const raw = document.createElement('details'), label = document.createElement('summary'), pre = document.createElement('pre');
      label.textContent = '原始输入 / 输出'; pre.textContent = JSON.stringify({ input: entry.tool.rawInput, output: entry.tool.rawOutput }, null, 2); raw.append(label, pre); body.append(raw);
    }
    node.append(body);
  } else {
    if (entry.role === 'thought') { const summary = document.createElement('summary'); summary.textContent = '思考过程'; node.append(summary); }
    else if (entry.role !== 'notice') { const label = document.createElement('div'); label.className = 'speaker'; label.textContent = entry.role === 'user' ? '你' : 'π  PI'; node.append(label); }
    const body = document.createElement('div'); body.className = 'markdown';
    body.innerHTML = renderMarkdown(entry.text); node.append(body);
    if (entry.role === 'assistant') node.append(button('复制 Markdown', async () => { try { await navigator.clipboard.writeText(entry.text); } catch { /* clipboard can be unavailable in browser previews */ } }, 'copy-message'));
  }
  return node;
}
function paint() {
  paintPending = false;
  if (!state) return;
  const busy = state.status === 'busy', connecting = state.status === 'connecting';
  const statuses = { disconnected: '未连接', connecting: '正在连接…', ready: '已连接', busy: '正在工作' };
  el('status').textContent = state.preview ? '渲染预览 · 离线' : `${statuses[state.status]}${state.agent ? ' · ' + state.agent : ''}`;
  el('connection').dataset.status = state.status;
  el('connect').hidden = state.status === 'ready' || busy;
  el<HTMLButtonElement>('connect').disabled = connecting;
  el<HTMLButtonElement>('new').disabled = busy || connecting;
  el('stop').hidden = !busy; el('send').hidden = busy; el('working').hidden = !busy;
  el('error').hidden = !state.error; el('error').textContent = state.error || '';
  el('welcome').hidden = !!state.entries.length;
  input.disabled = connecting;
  updateSend();
  const messages = el('messages');
  const visible = state.entries.filter(e => e.role !== 'thought' || state!.showThoughts);
  const ids = new Set(visible.map(e => e.id));
  for (const [id, item] of cache) if (!ids.has(id)) { item.node.remove(); cache.delete(id); }
  for (let index = 0; index < visible.length; index++) {
    const entry = visible[index]; const signature = JSON.stringify(entry);
    let cached = cache.get(entry.id);
    if (!cached || cached.signature !== signature) {
      const node = contentNode(entry);
      if (node instanceof HTMLDetailsElement && cached?.node instanceof HTMLDetailsElement) node.open = cached.node.open;
      if (cached) cached.node.replaceWith(node);
      cached = { signature, node }; cache.set(entry.id, cached);
    }
    if (messages.children[index] !== cached.node) messages.insertBefore(cached.node, messages.children[index] || null);
  }
  const attachments = el('attachments'); attachments.replaceChildren();
  for (const a of state.attachments) { const b = button(`📎 ${a.name} ×`, () => send({ type: 'removeAttachment', id: a.id })); b.title = '移除此上下文'; attachments.append(b); }
  const plan = el('plan'); plan.hidden = !state.plan.length; plan.replaceChildren();
  for (const item of state.plan) { const p = document.createElement('div'); p.textContent = `${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'} ${item.content}`; plan.append(p); }
  // Do not replace focused permission buttons on every streaming update.
  const permissions = el('permissions'); const permissionSignature = JSON.stringify(state.permissions);
  if (permissions.dataset.signature !== permissionSignature) {
    permissions.dataset.signature = permissionSignature; permissions.replaceChildren();
    for (const item of state.permissions) {
      const card = document.createElement('div'); card.className = 'permission-card';
      const h = document.createElement('strong'); h.textContent = `需要授权 · ${item.request.toolCall.title || '工具操作'}`; card.append(h);
      const details = document.createElement('pre'); details.textContent = JSON.stringify(item.request.toolCall, null, 2); card.append(details);
      const actions = document.createElement('div'); actions.className = 'permission-actions';
      for (const option of item.request.options) actions.append(button(option.name, () => send({ type: 'permission', id: item.id, optionId: option.optionId }), option.kind.startsWith('reject') ? '' : 'primary'));
      actions.append(button('取消', () => send({ type: 'permission', id: item.id }))); card.append(actions); permissions.append(card);
    }
  }
  const selectors = el('selectors'); const selectSignature = JSON.stringify([state.modes, state.configs, busy, connecting]);
  if (selectors.dataset.signature !== selectSignature) {
    selectors.dataset.signature = selectSignature; selectors.replaceChildren();
    const select = (label: string, current: string, options: { id: string; name: string }[], change: (value: string) => void) => {
      const s = document.createElement('select'); s.setAttribute('aria-label', label); s.title = label; s.disabled = busy || connecting;
      for (const o of options) { const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.name; s.append(opt); }
      s.value = current; s.onchange = () => change(s.value); selectors.append(s);
    };
    if (state.modes && !state.configs?.some(c => c.category === 'mode')) select('思考 / 会话模式', state.modes.currentModeId, state.modes.availableModes, value => send({ type: 'mode', value }));
    for (const config of state.configs || []) if (config.type === 'select') {
      const options = config.options.flatMap(o => 'options' in o ? o.options : [o]);
      select(config.name, config.currentValue, options.map(o => ({ id: o.value, name: o.name })), value => send({ type: 'config', id: config.id, value }));
    }
  }
  el('usage').textContent = state.usage ? `${Math.round(state.usage.used / Math.max(1, state.usage.size) * 100)}% 上下文` : '';
  const history = el('history-items'); history.replaceChildren();
  for (const snapshot of state.history) {
    const b = button(snapshot.title, () => { send({ type: 'resume', id: snapshot.id }); el('history').hidden = true; });
    b.disabled = busy || connecting; b.title = `${snapshot.cwd}\n${new Date(snapshot.updated).toLocaleString()}`; history.append(b);
  }
  if (!state.history.length) history.textContent = '还没有保存的会话。';
  if (followBottom) el('transcript').scrollTop = el('transcript').scrollHeight;
  commandMenu();
}
window.addEventListener('message', event => {
  if (event.data.type === 'sent') { input.value = ''; vscode.setState({ draft: '' }); sending = false; updateSend(); return; }
  if (event.data.type !== 'state') return;
  state = event.data.state;
  if (state?.status !== 'busy') sending = false;
  if (!paintPending) { paintPending = true; requestAnimationFrame(paint); }
});
send({ type: 'ready' });
