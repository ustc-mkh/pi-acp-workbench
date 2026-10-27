import { ModelControls } from './workbench-model-controls';
import { installTooltips } from './tooltips';
import { uiLabel } from './workbench-labels';
import { element, button } from './workbench-elements';
import { renderInteractions } from './workbench-interactions';
import { renderSettings } from './workbench-settings';
import { buildClassicShell, decorateIcon } from './workbench-shell';
import { MessageProjection } from '../src/workbench-messages';
import { reconcile } from './workbench-dom';
import { installComposerResize } from './composer-resize';
import { Drafts } from './workbench-drafts';
import { Preferences } from './workbench-preferences';
import { ManagementPanel } from './workbench-management';
import { AttachmentDrafts } from './workbench-attachment-drafts';
import { composePrompt } from '../src/workbench-input';
import { createRenderer } from './markdown';
import { renderDiagrams } from './diagrams';
import {
  ipcMessage,
  type ClientCommand,
  type ImageAsset,
  type ImageRef,
  type SessionView,
  type ContentRef,
  contentRef,
  contentSlice,
} from '../src/workbench-protocol';
import { uiStateMessage, type UiCommand, type WorkbenchUiState } from '../src/workbench-ui';

declare function acquireVsCodeApi(): {
  postMessage(message: UiCommand): void;
  getState?(): unknown;
  setState?(
    state: ReturnType<Drafts['snapshot']> &
      ReturnType<Preferences['snapshot']> &
      ReturnType<AttachmentDrafts['snapshot']>,
  ): void;
};
const vscode = acquireVsCodeApi(),
  root = document.querySelector<HTMLElement>('#workbench')!;
const markdown = createRenderer(window);
let state: WorkbenchUiState | undefined,
  sequence = 0,
  selected: string | undefined;
const images = new Map<string, { asset: ImageAsset; url: string }>();
const imageErrors = new Map<string, string>(),
  pendingImages = new Map<number, { image: string; session: string }>();
const diffContents = new Map<string, { text: string; nextOffset?: number | null }>();
const diffReads = new Set<string>();
const attemptedDiffs = new Set<string>();
const turnDiffs = new Map<string, import('../src/workbench-protocol').TurnDiff>();
let nextUiRequest = 0;
let titleRefreshTimer: number | undefined;
let imageBytes = 0,
  rendering = false;
const saved = vscode.getState?.();
const drafts = new Drafts(saved);
const preferences = new Preferences(saved);
const attachmentDrafts = new AttachmentDrafts(saved);
function persist() {
  vscode.setState?.({
    ...drafts.snapshot(),
    ...preferences.snapshot(),
    ...attachmentDrafts.snapshot(),
  });
}
function disclosure(key: string, fallback = false) {
  const details = element('details');
  details.dataset.key = key;
  details.open = preferences.open(key, fallback);
  details.addEventListener('toggle', () => {
    if (!details.isConnected || details.open === preferences.open(key, fallback)) return;
    preferences.setOpen(key, details.open);
    persist();
  });
  return details;
}
const pendingPrompts = new Map<string, Set<string>>();
const draftGenerations = new Map<string, number>();
const promptOperations = new Map<string, { generation: number; operation: string }>();
const pendingPiDrafts = new Map<
  string,
  {
    generation: number;
    after: number;
    text: string;
    attachments: ReturnType<AttachmentDrafts['get']>;
    image?: ImageAsset;
  }
>();
let nextDraftGeneration = 0;
function clearAcceptedDraft(session: string) {
  inputImages.delete(session);
  attachmentDrafts.set(session, []);
  drafts.set(session, '');
  if (session === selected) {
    prompt.value = '';
    renderAttachments();
  }
  persist();
}
function settlePiDraft() {
  if (!selected) return;
  const pending = pendingPiDrafts.get(selected);
  if (!pending || !state?.view?.view) return;
  const turn = state.view.entries.find(
    (entry) => entry.seq > pending.after && entry.role === 'User',
  )?.turn;
  if (!turn) return; // Do not guess across a missing history page.
  const rows = state.view.entries.filter((entry) => entry.turn === turn);
  const rejected = rows.some((entry) => entry.message === 'pi-workbench-input-rejected');
  const observed = rows.some((entry) => entry.role !== 'User');
  if (!rejected && !observed && state.view.view.active_turn) return;
  pendingPiDrafts.delete(selected);
  if (rejected) {
    const unchanged =
      pending.generation === (draftGenerations.get(selected) || 0) && !hasDraftContent();
    if (unchanged) {
      drafts.set(selected, pending.text);
      prompt.value = pending.text;
      attachmentDrafts.set(selected, pending.attachments);
      if (pending.image) inputImages.set(selected, pending.image);
      renderAttachments();
      persist();
    }
    error.textContent = unchanged
      ? 'Agent 正在后台工作，输入未发送，已恢复草稿。'
      : 'Agent 正在后台工作，输入未发送；当前草稿已保留，旧输入可从对应用户消息恢复。';
  }
}
function touchDraft(session = selected || '') {
  if (!draftGenerations.has(session) && draftGenerations.size >= 64)
    draftGenerations.delete(draftGenerations.keys().next().value!);
  draftGenerations.set(session, ++nextDraftGeneration);
}
function saveDraft() {
  drafts.set(selected || '', prompt.value);
  persist();
}
const send = (message: UiCommand) => vscode.postMessage(message);
const management = new ManagementPanel(send, schedule);
const modelControls = new ModelControls(schedule);
const header = element('header');
const harness = element('select');
harness.id = 'harness-switch';
harness.setAttribute('aria-label', '切换 Harness');
for (const name of ['Pi', 'Codex', 'Claude']) {
  const option = element(
    'option',
    name === 'Pi' ? 'Pi Agent' : name === 'Claude' ? 'Claude Code' : name,
  );
  option.value = name;
  harness.append(option);
}
const newSession = button(
  'New session',
  () => {
    previewActive = false;
    if (!state?.trusted || !state.workspace) return;
    send({
      type: 'create',
      command: {
        method: 'create',
        harness: harness.value as 'Pi' | 'Codex' | 'Claude',
        cwd: state.workspace,
      },
    });
  },
  true,
);
harness.value = preferences.harness;
harness.addEventListener('change', () => {
  saveDraft();
  preferences.harness = harness.value;
  persist();
  const last = preferences.lastSessions[harness.value];
  const target =
    state?.sessions.find((item) => item.harness === harness.value && item.id === last) ||
    state?.sessions.find((item) => item.harness === harness.value);
  if (target) send({ type: 'select', session: target.id });
  else send({ type: 'clear_selection' });
});
const refresh = button('Refresh', () => send({ type: 'refresh' }));
const login = button('Provider login…', () => send({ type: 'login' }));
const statistics = button('Usage statistics', () => management.openStatistics());
const models = button('Model settings', () => management.openModels());
const telegramSetup = button('Telegram setup', () => send({ type: 'configure_telegram' }));
const exportHistory = button('Export Markdown', () => {
  if (state?.selected) send({ type: 'export', session: state.selected as SessionView['id'] });
});
const advanced = element('details');
advanced.id = 'session-options';
const advancedSummary = element('summary', '⋯');
advancedSummary.setAttribute('aria-label', '会话选项');
advancedSummary.title = '会话选项';
document.addEventListener('pointerdown', (event) => {
  if (advanced.open && !advanced.contains(event.target as Node)) advanced.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && advanced.open) {
    advanced.open = false;
    advancedSummary.focus();
  }
});
const viewOptions = element('section');
advanced.append(advancedSummary, viewOptions, login, telegramSetup, refresh);
const historySearch = element('input');
historySearch.type = 'search';
historySearch.placeholder = '搜索会话名称、目录…';
historySearch.setAttribute('aria-label', '搜索全部会话');
historySearch.maxLength = 300;
const historyHarness = element('select');
historyHarness.setAttribute('aria-label', 'History harness filter');
for (const value of ['', 'Pi', 'Codex', 'Claude']) {
  const option = element('option', value || '全部 Agent');
  option.value = value;
  historyHarness.append(option);
}
const historyFilter = (): import('../src/workbench-protocol').SessionFilter => ({
  text: historySearch.value.trim(),
  harness: (historyHarness.value ||
    null) as import('../src/workbench-protocol').SessionFilter['harness'],
});
const historyControls = element('section');
historyControls.className = 'history-search-controls';
historyControls.append(
  historySearch,
  historyHarness,
  button('Search history', () => send({ type: 'refresh', filter: historyFilter() })),
);
historySearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing)
    send({ type: 'refresh', filter: historyFilter() });
});
const clearProgress = element('section');
const undoSelections = new Map<string, Set<string>>();
let historyReleaseConfirm: string | undefined;
let historyRemoveConfirm: string | undefined;
const sessions = element('div');
sessions.id = 'history-items';
sessions.setAttribute('role', 'listbox');
sessions.setAttribute('aria-label', '会话历史');
const historyPanel = element('section');
historyPanel.id = 'history';
const historyHeading = element('div', '会话历史');
historyHeading.className = 'section-label';
const historyActions = element('span');
historyControls.hidden = true;
historyActions.append(
  button('搜索', () => {
    historyControls.hidden = !historyControls.hidden;
    if (!historyControls.hidden) historySearch.focus();
  }),
  button('刷新', () => send({ type: 'refresh' })),
  button('清空', () => send({ type: 'prepare_history_clear', filter: historyFilter() })),
);
historyHeading.append(historyActions);
historyPanel.append(historyHeading, historyControls, clearProgress, sessions);
const status = element('p'),
  error = element('p'),
  settings = element('section'),
  planPanel = element('section'),
  transcript = element('main');
let previewActive = false;
let jumpToLatest = false;
const messages = element('div');
messages.id = 'messages';
const working = element('div');
working.id = 'working';
working.hidden = true;
const workingIcon = element('span');
workingIcon.className = 'session-indicator running';
const workingLabel = element('span');
working.append(workingIcon, workingLabel);
transcript.append(messages, working);
function requestAutomaticDiff(session: string, turn: string) {
  const snapshot = state?.view?.view;
  const entry = state?.view?.entries.find((row) => row.turn === turn);
  const key = `${session}:${turn}`;
  if (
    !snapshot ||
    session !== state?.selected ||
    session !== snapshot.id ||
    !entry ||
    turn === snapshot.active_turn ||
    turnDiffs.has(key) ||
    attemptedDiffs.has(key) ||
    diffReads.size >= 2
  )
    return;
  attemptedDiffs.add(key);
  diffReads.add(key);
  while (attemptedDiffs.size > 64) attemptedDiffs.delete(attemptedDiffs.keys().next().value!);
  send({ type: 'read_turn_diff', session: snapshot.id, turn: entry.turn, automatic: true });
}
const diffObserver =
  typeof window.IntersectionObserver === 'function'
    ? new window.IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const node = entry.target as HTMLElement;
            if (
              entry.isIntersecting &&
              node.isConnected &&
              node.dataset.sessionId &&
              node.dataset.turn
            )
              requestAutomaticDiff(node.dataset.sessionId, node.dataset.turn);
          }
        },
        { root: transcript, rootMargin: '200px' },
      )
    : undefined;

planPanel.id = 'plan';
planPanel.setAttribute('aria-label', '待办清单');
error.id = 'error-message';
const errorBanner = element('div');
errorBanner.id = 'error';
errorBanner.setAttribute('role', 'alert');
let dismissedError: string | undefined;
function errorIdentity() {
  const failed = state?.operations
    .filter((op) => op.status === 'failed' || op.status === 'uncertain')
    .at(-1);
  return `${selected || ''}:${failed?.operation || ''}:${error.textContent || ''}`;
}
function refreshErrorBanner() {
  if (!error.textContent) dismissedError = undefined;
  errorBanner.hidden = !error.textContent || dismissedError === errorIdentity();
}
const dismissError = button('×', () => {
  dismissedError = errorIdentity();
  refreshErrorBanner();
});
dismissError.id = 'dismiss-error';
dismissError.setAttribute('aria-label', '关闭错误提示');
dismissError.title = '关闭错误提示';
errorBanner.append(error, dismissError);
errorBanner.hidden = true;
new window.MutationObserver(refreshErrorBanner).observe(error, {
  childList: true,
  subtree: true,
  characterData: true,
});
status.id = 'status';
status.setAttribute('role', 'status');
transcript.id = 'transcript';
const interactions = element('section'),
  operations = element('section');
interactions.id = 'interactions';
operations.id = 'operations';
const composer = element('form'),
  prompt = element('textarea');
prompt.id = 'prompt';
prompt.setAttribute('aria-label', '发送消息');
prompt.placeholder = '描述任务，或输入 / 查看命令…';
prompt.rows = 3;
prompt.maxLength = 200000;
prompt.disabled = true;
const submit = element('button');
submit.id = 'send';
decorateIcon(submit, 'send', '发送消息');
submit.classList.add('primary', 'circle-button');
submit.type = 'submit';
submit.disabled = true;
const cancel = button('Cancel turn', () => mutate({ method: 'cancel', session: current()!.id }));
cancel.id = 'stop';
cancel.classList.add('primary', 'circle-button');
cancel.innerHTML = '<span class="stop-square" aria-hidden="true"></span>';
cancel.setAttribute('aria-label', '停止输出');
const attachments = element('section');
attachments.id = 'attachments';
attachments.setAttribute('aria-label', 'Explicit file attachments');
const inputImages = new Map<string, ImageAsset>();
let imageReading = false;
async function addInputImage(file: File) {
  const session = current()?.id;
  if (!session || imageReading) return;
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size <= 0 ||
    file.size > 4 * 1024 * 1024
  ) {
    error.textContent = 'Choose a static PNG/JPEG/WebP image up to 4 MiB';
    return;
  }
  if (!inputImages.has(session) && inputImages.size >= 4) {
    error.textContent =
      'Remove an unsent image from another session first (four-image draft budget)';
    return;
  }
  imageReading = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (selected !== session) throw new Error('Session changed while reading image');
    inputImages.set(session, {
      format_version: 1,
      image: {
        id: crypto.randomUUID() as ImageRef['id'],
        mime: file.type as ImageRef['mime'],
        bytes: bytes.length,
        sha256: [...digest].map((n) => n.toString(16).padStart(2, '0')).join(''),
      },
      data: btoa(binary),
    });
    touchDraft(session);
    renderAttachments();
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Image unavailable';
  } finally {
    imageReading = false;
  }
}
const imagePicker = element('input');
imagePicker.type = 'file';
imagePicker.accept = 'image/png,image/jpeg,image/webp';
imagePicker.hidden = true;
imagePicker.onchange = () => {
  const file = imagePicker.files?.[0];
  if (file) void addInputImage(file);
  imagePicker.value = '';
};
const attachImage = button('Attach image', () => imagePicker.click());
prompt.addEventListener('paste', (event) => {
  const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    event.preventDefault();
    void addInputImage(file);
  }
});
function hasDraftContent() {
  return Boolean(
    prompt.value.trim() ||
      inputImages.has(selected || '') ||
      attachmentDrafts.get(selected || '').length,
  );
}
function updateSend() {
  const snapshot = current();
  submit.disabled =
    !snapshot ||
    !state?.trusted ||
    state.view?.status !== 'ready' ||
    !!snapshot.active_turn ||
    state?.preparing === snapshot.id ||
    modelControls.busy ||
    pendingPrompts.has(snapshot.id) ||
    !hasDraftContent();
}
function composeDraft(session: string, text: string) {
  const image = inputImages.get(session);
  const context = attachmentDrafts.get(session);
  const result =
    image && !text.trim() && !context.length
      ? { parts: [] as import('../src/workbench-input').PromptPart[] }
      : composePrompt(text, context);
  if (image) result.parts.push({ type: 'image', asset: image });
  return result;
}
const attach = button('Attach files', () => {
  const snapshot = current();
  if (snapshot) send({ type: 'attach_files', session: snapshot.id });
});
const resize = element('div');
resize.className = 'composer-resize';
resize.tabIndex = 0;
resize.setAttribute('role', 'separator');
resize.setAttribute('aria-label', '调整输入区高度');
resize.setAttribute('aria-orientation', 'horizontal');
installComposerResize(resize, prompt, preferences.composerHeight, (height) => {
  preferences.composerHeight = height;
  persist();
});
const completions = element('div');
completions.id = 'commands';
completions.setAttribute('role', 'listbox');
completions.setAttribute('aria-label', 'Provider commands');
const composerBox = element('div');
composerBox.className = 'composer';
const composerTools = element('div');
composerTools.className = 'composer-tools';
const composerActions = element('div');
composerActions.className = 'composer-actions';
const contextUsage = element('span');
contextUsage.id = 'usage';
contextUsage.tabIndex = 0;
contextUsage.setAttribute('role', 'img');
contextUsage.innerHTML =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="usage-track" cx="12" cy="12" r="9.5"/><circle id="usage-fill" cx="12" cy="12" r="9.5" pathLength="100" transform="rotate(-90 12 12)"/></svg>';
const hint = element('span', 'Enter 发送 · Shift+Enter 换行');
hint.id = 'hint';
settings.id = 'selectors';
attach.id = 'attach';
attach.setAttribute('aria-label', '添加上下文');
attach.textContent = '＋ 上下文';
attachImage.classList.add('image-attachment-action');
decorateIcon(attachImage, 'image', '添加图片');
renderContextUsage();
composerActions.append(contextUsage, cancel, submit);
composerTools.append(attach, settings, hint, composerActions);
viewOptions.append(attachImage);
attach.oncontextmenu = (event) => {
  event.preventDefault();
  imagePicker.click();
};
attach.title = '添加当前编辑器的选区或文件；右键选择图片，也可粘贴图片';
composerBox.append(prompt, completions, composerTools, imagePicker);
composer.append(attachments, resize, composerBox);
let inputPreviewUrl: string | undefined;
function renderAttachments() {
  updateSend();
  if (inputPreviewUrl) {
    URL.revokeObjectURL(inputPreviewUrl);
    inputPreviewUrl = undefined;
  }
  attachments.replaceChildren();
  const image = inputImages.get(selected || '');
  if (image) {
    const preview = element('img');
    preview.alt = 'Unsent image preview';
    preview.style.maxWidth = '240px';
    const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    inputPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: image.image.mime }));
    preview.src = inputPreviewUrl;
    attachments.append(
      preview,
      element('p', `${image.image.bytes} bytes · unsent images are discarded on reload`),
      button('Remove image', () => {
        inputImages.delete(selected || '');
        touchDraft();
        renderAttachments();
      }),
    );
  }
  for (const file of attachmentDrafts.get(selected || '')) {
    const details = disclosure(`${selected}:attachment:${file.id}`);
    details.append(element('summary', `${file.name} · ${file.text.length} characters`));
    details.append(element('pre', file.text));
    details.append(
      button(`Remove attachment ${file.name}`, () => {
        touchDraft();
        attachmentDrafts.set(
          selected || '',
          attachmentDrafts.get(selected || '').filter((row) => row.id !== file.id),
        );
        persist();
        renderAttachments();
      }),
    );
    attachments.append(details);
  }
}
let commandIndex = 0,
  composing = false,
  dismissedCommand = '';
function commandChoices() {
  if (
    composing ||
    prompt.selectionStart !== prompt.value.length ||
    !/^\/[^\s]*$/.test(prompt.value) ||
    dismissedCommand === prompt.value
  )
    return [];
  return (current()?.catalogue.commands || [])
    .filter((command) => command.name.startsWith(prompt.value.slice(1)))
    .slice(0, 20);
}
function acceptCommand(index: number) {
  const command = commandChoices()[index];
  if (!command) return;
  prompt.value = `/${command.name} `;
  touchDraft();
  saveDraft();
  renderCommands();
  prompt.focus();
}
function renderCommands() {
  const choices = commandChoices();
  commandIndex = Math.min(commandIndex, Math.max(0, choices.length - 1));
  completions.replaceChildren();
  choices.forEach((command, index) => {
    const option = button(
      `/${command.name} — ${command.description}${command.input_hint ? ` (${command.input_hint})` : ''}`,
      () => acceptCommand(index),
    );
    option.setAttribute('role', 'option');
    option.id = `command-${index}`;
    option.setAttribute('aria-selected', String(index === commandIndex));
    completions.append(option);
  });
  prompt.setAttribute('aria-expanded', String(choices.length > 0));
  if (choices.length) prompt.setAttribute('aria-activedescendant', `command-${commandIndex}`);
  else prompt.removeAttribute('aria-activedescendant');
}
prompt.setAttribute('aria-controls', 'commands');
prompt.setAttribute('aria-autocomplete', 'list');
prompt.addEventListener('compositionstart', () => {
  composing = true;
  renderCommands();
});
prompt.addEventListener('compositionend', () => {
  composing = false;
  renderCommands();
});
prompt.addEventListener('input', () => {
  dismissedCommand = '';
  commandIndex = 0;
  touchDraft();
  saveDraft();
  renderCommands();
  updateSend();
});
prompt.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229 || composing) return;
  if (commandChoices().length) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') dismissedCommand = prompt.value;
      else if (event.key === 'ArrowDown')
        commandIndex = (commandIndex + 1) % commandChoices().length;
      else if (event.key === 'ArrowUp')
        commandIndex = (commandIndex + commandChoices().length - 1) % commandChoices().length;
      else {
        acceptCommand(commandIndex);
        return;
      }
      renderCommands();
      return;
    }
  }
  // Enter used to commit IME composition is not a send gesture.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!submit.disabled) composer.requestSubmit();
});
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const snapshot = current();
  if (!snapshot || submit.disabled || modelControls.busy || pendingPrompts.has(snapshot.id)) return;
  let text: ReturnType<typeof composePrompt>;
  try {
    text = composeDraft(snapshot.id, prompt.value);
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Invalid prompt';
    return;
  }
  if (
    snapshot.harness === 'Pi' &&
    !pendingPiDrafts.has(snapshot.id) &&
    pendingPiDrafts.size >= 16
  ) {
    error.textContent = '仍有输入等待 Agent 确认，请先查看这些会话的状态。';
    return;
  }
  if (pendingPrompts.size >= 16) {
    error.textContent = 'Too many pending input receipts; check operations before sending.';
    return;
  }
  saveDraft();
  touchDraft(snapshot.id);
  pendingPrompts.set(
    snapshot.id,
    new Set(state?.operations.map((operation) => operation.operation)),
  );
  submit.disabled = true;
  send({
    type: 'execute',
    session: snapshot.id,
    command: { method: 'prompt', session: snapshot.id, prompt: text },
    generation: draftGenerations.get(snapshot.id) || 0,
  });
});
const activity = button('展开执行过程', () => {
  const snapshot = current();
  if (!snapshot) return;
  preferences.activityExpanded = !preferences.activityExpanded;
  for (const turn of new Set((state?.view?.entries || []).map((row) => row.turn)))
    preferences.setOpen(`${snapshot.id}:turn:${turn}`, preferences.activityExpanded);
  persist();
  schedule();
});
activity.id = 'toggle-activity';
const historySize = element('div');
historySize.className = 'history-controls';
const lessHistory = button('收起历史列表', () => {
  if (preferences.sessionRows === 4) classic.showHistory(false);
  else {
    preferences.sessionRows = preferences.sessionRows === 16 ? 10 : 4;
    persist();
    schedule();
  }
});
const moreHistory = button('展开历史列表', () => {
  const available = state?.sessions.length || 0;
  if (preferences.sessionRows >= available || preferences.sessionRows === 16) return;
  preferences.sessionRows = preferences.sessionRows === 4 ? 10 : 16;
  persist();
  schedule();
});
for (const [control, path, label] of [
  [lessHistory, 'M4 12l6-6 6 6', '收起历史列表'],
  [moreHistory, 'M4 8l6 6 6-6', '展开历史列表'],
] as const) {
  control.setAttribute('aria-label', label);
  control.title = label;
  control.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg>`;
}
historySize.append(lessHistory, moreHistory);
historyPanel.append(historySize);
const classic = buildClassicShell({
  root,
  header,
  harness,
  newSession,
  activity,
  toolbar: [
    { node: exportHistory, icon: 'export', label: '导出 Markdown' },
    { node: models, icon: 'settings', label: '模型设置' },
    { node: statistics, icon: 'stats', label: '用量统计' },
  ],
  history: historyPanel,
  status,
  error: errorBanner,
  management: management.root,
  settings,
  plan: planPanel,
  transcript,
  interactions,
  operations,
  composer,
  advanced,
  historyOpen: preferences.historyOpen,
  onLatest: () => {
    const snapshot = current();
    if (snapshot && state?.view?.historical) {
      jumpToLatest = true;
      send({ type: 'latest', session: snapshot.id });
    }
  },
  onHistoryChange: (open) => {
    preferences.historyOpen = open;
    if (open) send({ type: 'refresh_names' });
    persist();
  },
});
installTooltips();
function current() {
  return state?.view?.view;
}
function mutate(command: ClientCommand) {
  const snapshot = current();
  if (snapshot) send({ type: 'execute', session: snapshot.id, command });
}
function schedule() {
  if (rendering) return;
  rendering = true;
  requestAnimationFrame(() => {
    rendering = false;
    const start = performance.now();
    render();
    performance.measure('workbench.render', { start });
    // Keep instrumentation bounded in a long-lived view.
    if (performance.getEntriesByName('workbench.render').length > 2048)
      performance.clearMeasures('workbench.render');
  });
}
function renderContextUsage(snapshot?: SessionView) {
  const used = snapshot?.usage.context_used,
    size = snapshot?.usage.context_size;
  const known = used != null && size != null && size > 0;
  const percent = known ? Math.min(100, Math.round((used / size) * 100)) : 0;
  const usageLabel = known ? `上下文占用 ${percent}% · ${used} / ${size}` : '上下文用量暂不可用';
  contextUsage.title = usageLabel;
  contextUsage.setAttribute('aria-label', usageLabel);
  contextUsage.dataset.level = !known ? 'unknown' : percent >= 90 ? 'high' : 'normal';
  contextUsage.querySelector('#usage-fill')?.setAttribute('stroke-dasharray', `${percent} 100`);
}

function imageNode(ref: ImageRef, session: SessionView['id']) {
  const box = element('figure'),
    cached = images.get(ref.id);
  if (cached) {
    images.delete(ref.id);
    images.set(ref.id, cached);
    const img = element('img');
    img.alt = 'Archived agent image';
    img.src = cached.url;
    box.append(img);
  } else {
    const load = button(
      [...pendingImages.values()].some((item) => item.image === ref.id)
        ? 'Loading image…'
        : 'Load archived image',
      () => {
        if (pendingImages.size >= 4) return;
        const request_id = ++nextUiRequest;
        pendingImages.set(request_id, { image: ref.id, session });
        send({ type: 'read_image', session, image: ref, request_id });
        schedule();
      },
      [...pendingImages.values()].some((item) => item.image === ref.id) || pendingImages.size >= 4,
    );
    box.append(load);
  }
  box.append(
    element(
      'figcaption',
      `${ref.mime} · ${ref.bytes} bytes${imageErrors.has(ref.id) ? ' · ' + imageErrors.get(ref.id) : ''}`,
    ),
  );
  return box;
}
const contentPages = new Map<
  string,
  { ref: ContentRef; offset: number; text: string; next: number | null }
>();
function contentNode(ref: ContentRef, session: SessionView['id']) {
  const box = element('section');
  const page = contentPages.get(ref.id);
  box.append(element('small', `Archived ${ref.kind} · ${ref.bytes} bytes`));
  box.append(
    button(page ? 'First content page' : 'Read content', () =>
      send({ type: 'read_content', session, ref, offset: 0 }),
    ),
  );
  if (page) {
    // Replace, never concatenate content pages. Each response is <=64KiB;
    // at most four open pages remain, below 256KiB per item and bounded overall.
    box.append(element('pre', page.text));
    if (page.next !== null)
      box.append(
        button('Next content page', () =>
          send({ type: 'read_content', session, ref, offset: page.next! }),
        ),
      );
  }
  return box;
}
const messageProjection = new MessageProjection();
const markdownCache = new Map<string, { text: string; html: string }>();
function renderMessageMarkdown(id: string, text: string) {
  const cached = markdownCache.get(id);
  if (cached?.text === text) return cached.html;
  const start = performance.now();
  const html = markdown(text);
  performance.measure('workbench.markdown', { start });
  if (performance.getEntriesByName('workbench.markdown').length > 2048)
    performance.clearMeasures('workbench.markdown');
  markdownCache.delete(id);
  markdownCache.set(id, { text, html });
  while (markdownCache.size > 16) markdownCache.delete(markdownCache.keys().next().value!);
  return html;
}
function hasIntermediateAnswers(
  rows: NonNullable<WorkbenchUiState['view']>['entries'],
  active?: string | null,
) {
  const turns = new Map<string, Set<string>>();
  for (const row of rows)
    if (row.role === 'Agent' && row.turn !== active) {
      const ids = turns.get(row.turn) || new Set<string>();
      ids.add(row.message || row.id);
      turns.set(row.turn, ids);
      if (ids.size > 1) return true;
    }
  return false;
}
function renderTranscript(snapshot: SessionView, busy: boolean) {
  const rows = state?.view?.entries || [];
  const scroll = transcript.scrollTop,
    bottom = transcript.scrollHeight - transcript.clientHeight - scroll < 80;
  const anchor = [...transcript.querySelectorAll<HTMLElement>('[data-entry]')].find(
    (node) => node.getBoundingClientRect().bottom >= transcript.getBoundingClientRect().top,
  );
  const anchorId = anchor?.dataset.entry;
  const anchorOffset = anchor?.getBoundingClientRect().top;
  const previousArticles = new Map(
    [...transcript.querySelectorAll<HTMLElement>('article[data-entry]')].map((node) => [
      node.dataset.entry,
      node,
    ]),
  );
  const output = element('section');
  const turns = new Map<string, { box: HTMLElement; process: HTMLDetailsElement }>();
  if (state?.view?.earlier)
    output.append(
      button(
        '加载更早消息（20 轮）',
        () => send({ type: 'earlier', session: snapshot.id }),
        !state?.view?.earlier,
      ),
    );
  output.append(
    element(
      'small',
      state?.view?.earlier ? '更早的消息尚未加载；可继续加载、复制或导出完整历史。' : '',
    ),
  );
  const projected = messageProjection.update(rows);
  const lastAnswers = new Map<string, string>();
  for (const message of projected)
    if (message.row.role === 'Agent' && !message.row.image)
      lastAnswers.set(message.row.turn, message.key);
  const folded = new Set<string>();
  for (const message of projected) {
    const completeText =
      message.inlineText ??
      (message.entries.every(
        (entry) =>
          'Inline' in entry.text ||
          state?.view?.resolvedText?.[entry.text.Archived.content.id] !== undefined,
      )
        ? message.entries
            .map((entry) =>
              'Inline' in entry.text
                ? entry.text.Inline.text
                : state!.view!.resolvedText![entry.text.Archived.content.id],
            )
            .join('')
        : undefined);
    const row =
      completeText !== undefined
        ? { ...message.row, text: { Inline: { text: completeText } } }
        : message.row;
    const inActivity =
      row.role === 'Thought' ||
      (row.role === 'Agent' &&
        !row.image &&
        snapshot.active_turn !== row.turn &&
        lastAnswers.get(row.turn) !== message.key);
    if (inActivity) folded.add(row.turn);
    let turn = turns.get(row.turn);
    if (!turn) {
      const box = element('section');
      box.dataset.turn = row.turn;
      box.className = 'turn';
      box.dataset.sessionId = snapshot.id;
      const process = disclosure(`${snapshot.id}:turn:${row.turn}`, preferences.activityExpanded);
      process.className = 'turn-process activity-group';
      process.append(element('summary', '思考与工具调用'));
      box.append(process);
      const savedDiff = turnDiffs.get(`${snapshot.id}:${row.turn}`);
      if (savedDiff && snapshot.active_turn !== row.turn) {
        const diffBox = element('article');
        diffBox.className = 'message turn-diff';
        diffBox.dataset.turnReview = 'true';
        const diffHeading = element('div');
        diffHeading.className = 'turn-diff-header';
        diffHeading.append(
          element(
            'strong',
            savedDiff.status === 'unavailable'
              ? '本轮修改 · 未能采集'
              : `本轮修改 · ${savedDiff.files.length} 个文件 · +${savedDiff.added} −${savedDiff.removed}${savedDiff.status === 'partial' ? '（部分结果）' : ''}`,
          ),
        );
        const diffActions = element('div');
        diffActions.className = 'turn-diff-actions';
        if (savedDiff.files.length) {
          const total = button('查看总 Diff', () =>
            send({ type: 'open_turn_diff', session: snapshot.id, turn: row.turn }),
          );
          total.className = 'diff-link';
          const undo = button(
            '撤回本轮修改',
            () =>
              send({
                type: 'execute',
                session: snapshot.id,
                command: { method: 'undo_turn', session: snapshot.id, turn: row.turn },
              }),
            busy ||
              snapshot.status !== 'Idle' ||
              savedDiff.status !== 'complete' ||
              savedDiff.next_offset !== null ||
              savedDiff.files.length > 256 ||
              savedDiff.files.reduce((n, f) => n + new TextEncoder().encode(f.path).length, 0) >
                65536,
          );
          undo.className = 'diff-link undo-turn';
          undo.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const batch = (event.currentTarget as HTMLElement)
              .closest('[data-turn-review]')
              ?.querySelector<HTMLDetailsElement>('.turn-diff-batch');
            if (batch) {
              batch.hidden = false;
              batch.open = true;
            }
          });
          undo.title =
            savedDiff.status !== 'complete'
              ? '本轮快照不完整，无法安全撤回。'
              : '确认后撤回本轮修改';
          diffActions.append(total, undo);
        }
        diffHeading.append(diffActions);
        diffBox.append(diffHeading);
        const summary = disclosure(`${snapshot.id}:diff:${row.turn}`, false);
        summary.className = 'turn-diff-files';
        summary.append(element('summary', `全部修改（${savedDiff.files.length} 个文件）`));
        if (!savedDiff.files.length) summary.append(element('p', '本轮未检测到文件净变化。'));
        const selectionKey = `${snapshot.id}:${row.turn}`;
        const selectedPaths = undoSelections.get(selectionKey) || new Set<string>();
        undoSelections.set(selectionKey, selectedPaths);
        while (undoSelections.size > 16) undoSelections.delete(undoSelections.keys().next().value!);
        const batchTools = disclosure(`${snapshot.id}:diff-batch:${row.turn}`, false);
        batchTools.className = 'turn-diff-batch';
        batchTools.append(element('summary', '按文件选择撤回…'));
        batchTools.hidden = !batchTools.open;
        if (savedDiff.status === 'complete') {
          batchTools.append(
            element(
              'p',
              '可按批选择最多 256 个文件（路径共 64 KiB），每批单独确认；冲突逐文件报告，可加载后续页继续选择。',
            ),
          );
          batchTools.append(
            button(
              'Undo selected files…',
              () => {
                if (selectedPaths.size)
                  send({
                    type: 'execute',
                    session: snapshot.id,
                    command: {
                      method: 'undo_turn',
                      session: snapshot.id,
                      turn: row.turn,
                      files: [...selectedPaths],
                    },
                  });
              },
              busy || snapshot.status !== 'Idle',
            ),
          );
        }
        for (const [index, file] of savedDiff.files.entries()) {
          const fileDetails = disclosure(
            `${snapshot.id}:diff:${row.turn}:file:${file.path}`,
            false,
          );
          fileDetails.className = 'turn-diff-file';
          const fileHeading = element(
            'summary',
            `${({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[file.status] || file.status} · ${file.path}  +${file.added} −${file.removed}`,
          );
          fileDetails.append(fileHeading);
          const fileBody = element('div');
          summary.append(fileDetails);
          if (savedDiff.status === 'complete') {
            const choice = element('input');
            choice.type = 'checkbox';
            choice.checked = selectedPaths.has(file.path);
            choice.hidden = !batchTools.open;
            batchTools.addEventListener('toggle', () => {
              choice.hidden = !batchTools.open;
            });
            choice.setAttribute('aria-label', `Select for undo: ${file.path}`);
            choice.addEventListener('change', () => {
              if (choice.checked) {
                const bytes = [...selectedPaths, file.path].reduce(
                  (n, path) => n + new TextEncoder().encode(path).length,
                  0,
                );
                if (selectedPaths.size >= 256 || bytes > 65536) {
                  choice.checked = false;
                  error.textContent =
                    'Undo batch limit: 256 files / 64 KiB paths. Confirm this batch before selecting more.';
                  return;
                }
                selectedPaths.add(file.path);
              } else selectedPaths.delete(file.path);
            });
            fileHeading.append(choice);
          }
          if (file.old_mode !== file.new_mode)
            fileBody.append(
              element(
                'p',
                `Permissions: ${file.old_mode?.toString(8) ?? 'absent'} → ${file.new_mode?.toString(8) ?? 'absent'}`,
              ),
            );
          fileBody.append(
            button('Compare file in editor', () =>
              send({ type: 'open_turn_diff', session: snapshot.id, turn: row.turn, file: index }),
            ),
          );
          if (file.omitted) {
            fileBody.append(
              element(
                'p',
                file.omitted === 'Diff content can be loaded in bounded slices.'
                  ? '完整内容已归档，可按需读取或在编辑器中对比。'
                  : file.omitted,
              ),
            );
            for (const after of [false, true])
              if ((after ? file.after : file.before) === null)
                fileBody.append(
                  button(after ? 'Load after' : 'Load before', () =>
                    send({
                      type: 'read_turn_diff_content',
                      session: snapshot.id,
                      turn: row.turn,
                      file: index,
                      after,
                      offset: 0,
                    }),
                  ),
                );
          }
          for (const after of [false, true]) {
            const loaded = diffContents.get(`${snapshot.id}:${row.turn}:${index}:${after}`);
            if (loaded) {
              const pre = element('pre');
              pre.textContent = loaded.text.slice(0, 30000).split('\n').slice(0, 400).join('\n');
              fileBody.append(pre);
              if (loaded.text.length > 30000 || loaded.text.split('\n').length > 400)
                fileBody.append(element('p', '预览已截断；在编辑器中查看完整差异。'));
              if (
                loaded.text.length < 30000 &&
                loaded.nextOffset !== null &&
                loaded.nextOffset !== undefined
              )
                fileBody.append(
                  button('Load next content slice', () =>
                    send({
                      type: 'read_turn_diff_content',
                      session: snapshot.id,
                      turn: row.turn,
                      file: index,
                      after,
                      offset: loaded.nextOffset!,
                    }),
                  ),
                );
            }
          }
          if (file.patch) {
            const patch = element('pre');
            patch.className = 'turn-diff-patch';
            for (const line of file.patch.slice(0, 30000).split('\n').slice(0, 400)) {
              const span = element('span', line + '\n');
              span.className = line.startsWith('+')
                ? 'diff-add'
                : line.startsWith('-')
                  ? 'diff-remove'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : '';
              patch.append(span);
            }
            fileBody.append(patch);
          }
          if (!file.patch && file.before !== null) {
            fileBody.append(element('h4', '修改前'));
            const pre = element('pre');
            pre.textContent = file.before ?? '';
            fileBody.append(pre);
          }
          if (!file.patch && file.after !== null) {
            fileBody.append(element('h4', '修改后'));
            const pre = element('pre');
            pre.textContent = file.after ?? '';
            fileBody.append(pre);
          }
          // Native details hides its body while collapsed. Keep the bounded
          // body reconciled so a lazy content response updates the live node,
          // rather than an old toggle listener reattaching an obsolete body.
          fileDetails.append(fileBody);
        }
        if (savedDiff.next_offset !== null)
          summary.append(
            button('Next diff page', () =>
              send({
                type: 'read_turn_diff',
                session: snapshot.id,
                turn: row.turn,
                offset: savedDiff.next_offset!,
              }),
            ),
          );
        diffBox.append(summary);
        if (savedDiff.status === 'complete') diffBox.append(batchTools);
        const notes = element('div');
        notes.className = 'turn-diff-notes';
        const omitted = savedDiff.files.filter(
          (f) => f.omitted && f.omitted !== 'Diff content can be loaded in bounded slices.',
        ).length;
        if (omitted)
          notes.append(
            element('p', `${omitted} 个文件未采集文本内容（大小限制、二进制、子模块或读取失败）。`),
          );
        for (const warning of savedDiff.warnings) notes.append(element('p', warning));
        notes.append(
          element(
            'p',
            '工作区本轮开始到结束的净变化；不含 Git 忽略文件。并发的手工或其他会话修改也可能计入；不是文件回滚点。',
          ),
        );
        summary.append(notes);
        box.append(diffBox);
      }
      turn = { box, process };
      turns.set(row.turn, turn);
      output.append(box);
    }
    if (row.role === 'Thought' && !preferences.showThoughts) continue;
    const definition = JSON.stringify([
      row.id,
      message.entries.at(-1)!.id,
      message.entries.length,
      row.role !== 'User' && snapshot.active_turn === row.turn,
      message.entries.flatMap((entry) =>
        'Archived' in entry.text
          ? [
              contentPages.get(entry.text.Archived.content.id),
              state?.view?.resolvedText?.[entry.text.Archived.content.id]?.length,
            ]
          : [],
      ),
      row.image
        ? [
            images.get(row.image.id)?.url,
            imageErrors.get(row.image.id),
            [...pendingImages.values()].some((pending) => pending.image === row.image?.id),
            pendingImages.size >= 4,
          ]
        : null,
    ]);
    const previous = previousArticles.get(message.key);
    if (previous?.dataset.definition === definition) {
      const placeholder = element('article');
      placeholder.dataset.entry = message.key;
      placeholder.dataset.definition = definition;
      if (inActivity) turn.process.append(placeholder);
      else if (row.role === 'User') turn.box.insertBefore(placeholder, turn.process);
      else turn.box.append(placeholder);
      continue;
    }
    const article = element('article');
    article.dataset.definition = definition;
    article.dataset.entry = message.key;
    article.className = 'message ' + (row.role === 'Agent' ? 'assistant' : row.role.toLowerCase());
    article.classList.toggle('running-turn', snapshot.active_turn === row.turn);
    const actions = element('div');
    actions.className = 'message-actions';
    actions.append(
      button('Copy message', () =>
        send({ type: 'copy_message', session: snapshot.id, entry: row.id }),
      ),
    );
    if (row.role === 'User' && !row.image && 'Inline' in row.text) {
      const text = row.text.Inline.text;
      actions.append(
        button('Use as prompt', () => {
          const next = prompt.value ? `${prompt.value}\n\n${text}` : text;
          if (next.length > prompt.maxLength) {
            error.textContent = 'Combined draft exceeds the prompt budget';
            return;
          }
          prompt.value = next;
          touchDraft();
          saveDraft();
          prompt.focus();
        }),
      );
    }
    const content = element('div');
    content.className = 'message-body';
    if ('Inline' in row.text) {
      // Streaming text stays cheap and selectable. Parse only geometrically growing
      // prefixes; the unparsed tail remains visible until the next checkpoint/end.
      const text = row.text.Inline.text;
      const active = row.role !== 'User' && snapshot.active_turn === row.turn;
      const checkpoint = active
        ? Math.min(128 * 1024, 2 ** Math.floor(Math.log2(Math.max(1, text.length))))
        : Math.min(text.length, 2 * 1024 * 1024);
      const parsed = element('div');
      parsed.dataset.markdown = 'true';
      parsed.className = 'markdown';
      parsed.dataset.definition = `${row.id}:${checkpoint}`;
      const oldPrefix = previous?.querySelector<HTMLElement>('[data-markdown]');
      if (oldPrefix?.dataset.definition !== parsed.dataset.definition)
        parsed.innerHTML = renderMessageMarkdown(row.id, text.slice(0, checkpoint));
      content.append(parsed);
      if (checkpoint < text.length)
        content.append(element('pre', text.slice(checkpoint, checkpoint + 256 * 1024)));
      if (text.length > checkpoint + 256 * 1024)
        content.append(
          element(
            'p',
            'Display budget reached. Copy message or export Markdown for complete content.',
          ),
        );
      parsed.querySelectorAll('a').forEach((link) => {
        link.onclick = (event) => {
          event.preventDefault();
          send({
            type: 'open_link',
            url: (event.currentTarget as HTMLAnchorElement).getAttribute('href') || '',
          });
        };
      });
      for (const copy of parsed.querySelectorAll<HTMLButtonElement>('.copy-code'))
        copy.onclick = (event) => {
          const copy = event.currentTarget as HTMLButtonElement;
          const text = copy.parentElement?.querySelector('code')?.textContent ?? '';
          void window.navigator.clipboard?.writeText(text).then(
            () => {
              copy.textContent = '已复制';
            },
            () => {
              copy.textContent = '无法复制';
            },
          );
        };
      if (parsed.querySelector('.mermaid-diagram')) {
        const draw = button('Render diagrams', () => {});
        draw.onclick = (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          void renderDiagrams(button.parentElement!).finally(() => {
            button.disabled = false;
          });
        };
        parsed.prepend(draw);
      }
    } else
      for (const part of message.entries) {
        if ('Archived' in part.text)
          content.append(contentNode(part.text.Archived.content, snapshot.id));
        else content.append(element('pre', part.text.Inline.text));
      }
    if (row.role === 'Thought') {
      const details = disclosure(`${snapshot.id}:thought:${row.id}`);
      details.append(element('summary', '思考过程'), content);
      article.append(details);
    } else article.append(content);
    if (row.image) article.append(imageNode(row.image, snapshot.id));
    if (['Agent', 'User'].includes(row.role) && !row.image) {
      const fork = button('Fork here', () =>
        mutate({
          method: 'fork',
          session: snapshot.id,
          request: { entry: message.entries.at(-1)!.id },
        }),
      );
      fork.dataset.fork = 'true';
      actions.append(fork);
    }
    article.append(actions);
    if (inActivity) turn.process.append(article);
    else if (row.role === 'User') turn.box.insertBefore(article, turn.process);
    else turn.box.append(article);
  }
  for (const turn of turns.values()) {
    const diff = turn.box.querySelector<HTMLElement>(':scope > [data-turn-review]');
    if (diff) turn.box.append(diff);
  }
  const visibleTurns = new Set(rows.map((row) => row.turn));
  // Always prioritize the latest settled result, even with scroll-follow off
  // or before IntersectionObserver reports the new layout. Older turns remain
  // viewport-lazy (a recent window in non-layout renderers).
  const latestFinished = [...rows].reverse().find((row) => row.turn !== snapshot.active_turn);
  if (latestFinished) requestAutomaticDiff(snapshot.id, latestFinished.turn);
  if (!diffObserver)
    for (const turn of [...visibleTurns].slice(-16)) requestAutomaticDiff(snapshot.id, turn);
  for (const turn of visibleTurns) {
    const process = turns.get(turn)!.process;
    process.hidden =
      !preferences.activityExpanded &&
      !folded.has(turn) &&
      !rows.some((row) => row.turn === turn && row.role === 'Thought') &&
      !state?.view?.tools.some((tool) => tool.turn === turn);
    const thoughtCount = rows.filter((row) => row.turn === turn && row.role === 'Thought').length;
    const toolCount = state?.view?.tools.filter((tool) => tool.turn === turn).length || 0;
    process.querySelector('summary')!.textContent =
      `${snapshot.active_turn === turn ? '处理中' : '执行过程'} · ${toolCount} 次工具调用${thoughtCount ? ` · ${thoughtCount} 段思考` : ''}`;
    process.classList.toggle('running', snapshot.active_turn === turn);
    const tools = button('查看工具记录', () =>
      send({ type: 'read_tools', session: snapshot.id, turn }),
    );
    tools.dataset.toolsFor = turn;
    turns.get(turn)!.process.append(tools);
  }
  const cursor = state?.view?.toolCursor;
  if (cursor)
    output.append(
      button('Next tool page', () =>
        send({ type: 'read_tools', session: snapshot.id, turn: cursor.turn, cursor }),
      ),
    );
  for (const tool of state?.view?.tools || []) {
    if (!visibleTurns.has(tool.turn)) continue;
    const details = disclosure(`${snapshot.id}:tool:${tool.id}`);
    details.append(element('summary', `${tool.title} · ${tool.status}`));
    for (const body of tool.content) {
      if ('Text' in body) details.append(contentNode(body.Text.content, snapshot.id));
      else if ('Diff' in body) {
        details.append(element('p', body.Diff.path));
        if (body.Diff.old_text) details.append(contentNode(body.Diff.old_text, snapshot.id));
        details.append(contentNode(body.Diff.new_text, snapshot.id));
      } else if ('ResourceText' in body) {
        details.append(
          element('p', body.ResourceText.uri),
          contentNode(body.ResourceText.content, snapshot.id),
        );
      } else if ('ResourceLink' in body)
        details.append(element('p', `${body.ResourceLink.name}: ${body.ResourceLink.uri}`));
      else if ('TerminalReference' in body)
        details.append(
          element(
            'p',
            `Terminal ${body.TerminalReference.id}: metadata-only. This ACP client does not negotiate terminal execution/output; no stdout, stderr or exit status was captured.`,
          ),
        );
      else details.append(element('p', `Unsupported binary: ${body.Unsupported.kind}`));
    }
    turns.get(tool.turn)!.process.append(details);
  }
  renderCommands();
  const signature = JSON.stringify([snapshot.id, snapshot.plan]);
  if (planPanel.dataset.definition !== signature) {
    planPanel.dataset.definition = signature;
    planPanel.replaceChildren();
    if (snapshot.plan.items.length) {
      const plan = disclosure(`${snapshot.id}:plan`, true);
      planPanel.classList.add('todo-panel');
      plan.append(
        element(
          'summary',
          `待办清单 · ${snapshot.plan.items.filter((item) => item.status === 'Completed').length}/${snapshot.plan.items.length}`,
        ),
      );
      const list = element('ul');
      list.className = 'todo-list';
      list.setAttribute('aria-label', '待办事项');
      list.tabIndex = 0;
      for (const item of snapshot.plan.items) {
        const line = element('li');
        const status =
          item.status === 'Completed'
            ? 'completed'
            : item.status === 'InProgress'
              ? 'in_progress'
              : 'pending';
        line.className = `todo-item ${status}`;
        const circle = element('span', status === 'completed' ? '✓' : '');
        circle.className = 'todo-circle';
        circle.setAttribute('role', 'img');
        circle.setAttribute(
          'aria-label',
          status === 'completed' ? '已完成' : status === 'in_progress' ? '进行中' : '待处理',
        );
        const label = element('span', item.description);
        label.className = 'todo-label';
        line.append(circle, label);
        list.append(line);
      }
      plan.append(list);
      planPanel.append(plan);
    }
  }
  reconcile(messages, output);
  diffObserver?.disconnect();
  for (const turn of messages.querySelectorAll<HTMLElement>('section.turn[data-turn]'))
    diffObserver?.observe(turn);
  messages.classList.toggle('busy', Boolean(snapshot.active_turn));
  for (const fork of transcript.querySelectorAll<HTMLButtonElement>('[data-fork]'))
    fork.disabled = busy || snapshot.status !== 'Idle';
  const restored = [...transcript.querySelectorAll<HTMLElement>('[data-entry]')].find(
    (node) => node.dataset.entry === anchorId,
  );
  transcript.scrollTop =
    (bottom && preferences.autoScroll) ||
    (jumpToLatest && !state?.view?.historical && state?.view?.status === 'ready')
      ? transcript.scrollHeight
      : restored && anchorOffset !== undefined
        ? scroll + restored.getBoundingClientRect().top - anchorOffset
        : scroll;
  if (jumpToLatest && !state?.view?.historical && state?.view?.status === 'ready')
    jumpToLatest = false;
}
function render() {
  if (!state) return;
  if (selected !== state.selected) {
    jumpToLatest = false;
    saveDraft();
    selected = state.selected;
    prompt.value = drafts.get(selected || '');
    renderAttachments();
    for (const image of images.values()) URL.revokeObjectURL(image.url);
    images.clear();
    contentPages.clear();
    turnDiffs.clear();
    diffReads.clear();
    attemptedDiffs.clear();
    diffContents.clear();
    imageBytes = 0;
    imageErrors.clear();
    pendingImages.clear();
    interactions.replaceChildren();
    planPanel.replaceChildren();
    delete planPanel.dataset.definition;
    transcript.scrollTop = 0;
  }
  clearProgress.replaceChildren();
  const jobs = new Map<string, import('../src/workbench-protocol').HistoryClearReport>();
  for (const op of state.operations)
    if (op.historyClear) jobs.set(op.historyClear.job, op.historyClear);
  for (const report of jobs.values()) {
    clearProgress.append(
      element(
        'p',
        `Shared clear job ${report.job}: ${report.total} frozen targets, ${report.remaining} pending, ${report.failed} failed; preview included ${report.active} active tasks and ${report.pending_deliveries} pending deliveries. Includes Telegram and all matching harnesses/directories; native files, usage and delivery/dedup identities are retained.`,
      ),
    );
    if (report.remaining)
      clearProgress.append(
        button(report.preview ? 'Confirm first clear batch…' : 'Confirm next clear batch…', () =>
          send({ type: 'clear_history_batch', job: report.job }),
        ),
      );
  }
  const historyRows = element('div');
  sessions.dataset.selected = state.selected || '';
  const maximumTier = state.sessions.length <= 4 ? 4 : state.sessions.length <= 10 ? 10 : 16;
  if (preferences.sessionRows > maximumTier) {
    preferences.sessionRows = maximumTier;
    persist();
  }
  moreHistory.disabled =
    preferences.sessionRows >= state.sessions.length || preferences.sessionRows === 16;
  sessions.dataset.limit = String(preferences.sessionRows);
  const listedSessions = state.sessions.map((session) => ({ ...session, outside: false }));
  const restored = current();
  if (restored && !listedSessions.some((session) => session.id === restored.id))
    listedSessions.unshift({
      id: restored.id,
      harness: restored.harness,
      cwd: restored.cwd,
      status: restored.status,
      revision: restored.revision,
      created_seq: 0,
      title: '当前会话（不在此列表页）',
      outside: true,
    });
  for (const session of listedSessions) {
    const row = element('div');
    row.className = 'history-row' + (session.id === state.selected ? ' current' : '');
    row.dataset.key = `history:${session.id}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(session.id === state.selected));
    row.dataset.sessionId = session.id;
    const open = button(
      session.title || `新对话 #${session.created_seq}`,
      () => {
        send({ type: 'select', session: session.id });
        classic.showHistory(false);
      },
      false,
      false,
    );
    open.className = 'history-open';
    open.title = `${session.harness} · ${session.cwd}`;
    const number = element(
      'span',
      session.outside ? '当前' : '#' + String(session.created_seq).padStart(3, '0'),
    );
    number.className = 'session-number';
    number.dataset.retention = String(session.retention_days || 0);
    number.classList.toggle('alive-long', session.retention_days === 4);
    number.classList.toggle('alive-short', session.retention_days === 1);
    number.title =
      session.retention_days === 4
        ? '驻留保留 4 天（按最后用户输入）'
        : session.retention_days === 1
          ? '驻留保留 1 天（按最后用户输入）'
          : '当前未驻留；使用时恢复会话';
    const phase = element('span');
    phase.className = 'session-indicator';
    phase.dataset.phase = typeof session.status === 'string' ? session.status : 'Failed';
    phase.title = phase.dataset.phase;
    phase.classList.toggle('running', phase.dataset.phase === 'Running');
    phase.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 3v-3H3V4.5a1 1 0 0 1 1-1Z"/></svg>';
    const provider = element('span', session.harness);
    provider.className = 'history-harness';
    provider.hidden = session.harness === 'Pi';
    const removeHistory = button(
      '删除会话',
      () => {
        if (historyRemoveConfirm === session.id && selected === session.id) {
          historyRemoveConfirm = undefined;
          mutate({ method: 'remove', session: session.id });
        } else {
          historyRemoveConfirm = session.id;
          if (selected !== session.id) send({ type: 'select', session: session.id });
          else schedule();
        }
      },
      !state.trusted,
    );
    removeHistory.className = 'history-delete';
    removeHistory.setAttribute(
      'aria-label',
      historyRemoveConfirm === session.id
        ? `确认删除会话：${session.title || session.id}`
        : `删除会话：${session.title || session.id}`,
    );
    removeHistory.title =
      historyRemoveConfirm === session.id ? '再次点击确认删除（保留原生数据）' : '删除会话';
    removeHistory.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M7 5.5V3h6v2.5M5 5.5l.8 11h8.4l.8-11M8 8v5.5M12 8v5.5"/></svg>';
    const running = ['Running', 'Waiting', 'Cancelling'].includes(
      typeof session.status === 'string' ? session.status : '',
    );
    const release = button(
      '释放会话',
      () => {
        if (running && historyReleaseConfirm !== session.id) {
          historyReleaseConfirm = session.id;
          schedule();
          return;
        }
        send({ type: 'release_session', session: session.id, confirmed: running });
        historyReleaseConfirm = undefined;
      },
      !state.trusted || !session.retention_days,
    );
    release.className = 'history-release';
    release.setAttribute(
      'aria-label',
      `${historyReleaseConfirm === session.id ? '确认释放会停止当前任务：' : '释放会话：'}${session.title || session.id}`,
    );
    release.title =
      historyReleaseConfirm === session.id
        ? '再次点击停止任务并释放；保留历史'
        : '释放后台会话（保留历史）';
    release.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v8M5.5 4.5a7 7 0 1 0 9 0"/></svg>';
    row.append(phase, number, provider, open, release, removeHistory);
    historyRows.append(row);
  }
  if (!listedSessions.length) historyRows.append(element('p', '还没有保存的会话。'));
  reconcile(sessions, historyRows);
  document.querySelector('[data-session-page]')?.remove();
  const nextSessions = state.sessionsCursor;
  if (nextSessions) {
    const page = element('div');
    page.dataset.sessionPage = 'true';
    page.append(
      button('Next session page', () => send({ type: 'refresh', cursor: nextSessions })),
      button('Latest session page', () => send({ type: 'refresh' })),
    );
    sessions.after(page);
  }
  const visibleImages = new Set<string>(
    (state.view?.entries || []).flatMap((row) => (row.image ? [row.image.id as string] : [])),
  );
  for (const [request_id, pending] of pendingImages)
    if (pending.session !== state.selected || !visibleImages.has(pending.image))
      pendingImages.delete(request_id);
  for (const id of imageErrors.keys()) if (!visibleImages.has(id)) imageErrors.delete(id);
  const snapshot = current();
  error.textContent =
    state.error ||
    state.view?.error ||
    (snapshot && typeof snapshot.status === 'object' ? snapshot.status.Failed : '') ||
    (state.operations.some((op) => op.status === 'uncertain')
      ? '有操作结果尚未确认，请打开会话选项查询原结果；不会自动重发。'
      : '');
  settlePiDraft();
  newSession.disabled =
    !state.trusted ||
    !state.workspace ||
    Boolean(state.preparing) ||
    state.operations.some((op) => op.method === 'create' && op.status === 'pending');
  harness.disabled = newSession.disabled;
  const phase = snapshot && typeof snapshot.status === 'string' ? snapshot.status : 'Failed';
  status.textContent = !state.trusted
    ? '请先信任工作区'
    : !snapshot
      ? '选择或新建会话'
      : (
          { Idle: '就绪', Running: '正在处理…', Waiting: '等待授权', Failed: '任务失败' } as Record<
            string,
            string
          >
        )[phase] || phase;
  if (state.preparing && state.preparing === snapshot?.id)
    status.textContent = '正在加载模型与偏好…';
  status.title = `连接：${state.view?.status || '未选择'}${snapshot ? ` · revision ${snapshot.revision}` : ''}`;
  if (snapshot) {
    harness.value = snapshot.harness;
    preferences.harness = snapshot.harness;
    preferences.lastSessions[snapshot.harness] = snapshot.id;
  }
  const summary = state.sessions.find((item) => item.id === snapshot?.id);
  activity.textContent = preferences.activityExpanded ? '收起执行过程' : '展开执行过程';
  activity.setAttribute('aria-pressed', String(preferences.activityExpanded));
  activity.hidden = !snapshot;
  classic.update({
    hasSession: Boolean(snapshot),
    title: snapshot ? summary?.title || `${snapshot.harness} · #${summary?.created_seq ?? ''}` : '',
    status: status.textContent,
    busy: Boolean(snapshot?.active_turn),
    connected: state.view?.status === 'ready',
    harness: harness.value,
    number: summary?.created_seq,
    retentionDays: summary?.retention_days,
    entries: state.view?.entries.length || 0,
    preview: previewActive && !snapshot,
    historical: state.view?.historical,
    hasActivity: Boolean(
      state.view?.entries.some((row) => row.role === 'Thought') ||
        hasIntermediateAnswers(state.view?.entries || [], snapshot?.active_turn) ||
        state.view?.tools.length ||
        preferences.activityExpanded,
    ),
  });
  refreshErrorBanner();
  exportHistory.disabled = !snapshot;
  const busy =
    !snapshot ||
    !state.trusted ||
    state.view?.status !== 'ready' ||
    snapshot.active_turn !== null ||
    state.preparing === snapshot.id ||
    modelControls.busy;
  submit.disabled = busy || pendingPrompts.has(snapshot?.id || '') || !hasDraftContent();
  submit.setAttribute(
    'aria-label',
    pendingPrompts.has(snapshot?.id || '') ? '正在确认发送…' : '发送消息',
  );
  prompt.disabled = !snapshot;
  attach.disabled = !snapshot || !state.trusted;
  attachImage.disabled = !snapshot || !state.trusted;
  cancel.disabled =
    !snapshot || !state.trusted || (snapshot.active_turn === null && snapshot.harness !== 'Pi');
  cancel.setAttribute('aria-label', snapshot?.active_turn ? '停止输出' : '停止后台任务');
  cancel.title = snapshot?.active_turn ? '停止输出' : '停止后台任务';
  cancel.hidden = !snapshot?.active_turn;
  submit.hidden = Boolean(snapshot?.active_turn);
  management.setView(snapshot, state.sessions, state.operations);
  if (snapshot) {
    sessions.dataset.limit = String(preferences.sessionRows);
    renderSettings(snapshot, {
      settings,
      viewOptions,
      attachImage,
      modelControls,
      management,
      state: () => state,
      busy,
      preferences,
      activity,
      mutate,
      persist,
      schedule,
    });
    renderContextUsage(snapshot);
    working.hidden = !snapshot.active_turn;
    workingLabel.textContent = `${snapshot.harness} 正在处理…`;
    renderTranscript(snapshot, busy);
    renderInteractions(interactions, snapshot, mutate);
  } else {
    modelControls.show(false);
    renderContextUsage();
    settings.replaceChildren();
    viewOptions.replaceChildren();
    delete settings.dataset.definition;
    planPanel.replaceChildren();
    delete planPanel.dataset.definition;
    working.hidden = true;
    messages.replaceChildren();
    if (previewActive) {
      const article = element('article');
      article.className = 'message assistant';
      const body = element('div');
      body.className = 'markdown';
      body.innerHTML = markdown(
        '## Markdown 与公式\n\n这是离线渲染预览。**粗体**、列表、代码和公式均在本地展示。\n\n- 不连接 Agent\n- 不创建会话\n\n```ts\nconst answer = 42;\n```\n\n$$E = mc^2$$',
      );
      article.append(body);
      messages.append(article);
    }
    interactions.replaceChildren();
  }
  operations.replaceChildren();
  if (state.operations.some((operation) => operation.status === 'uncertain'))
    operations.append(
      button('Check operation receipts (never resend)', () => send({ type: 'recover_operations' })),
    );
  for (const operation of state.operations.slice(-12)) {
    const row = element(
      'p',
      `${operation.method} · ${operation.status} · ${operation.operation}${operation.code ? ' · ' + operation.code : ''}${operation.error ? ': ' + operation.error : ''}`,
    );
    if (operation.method === 'fork' && operation.status === 'pending')
      row.append(
        button('Cancel this fork', () =>
          send({ type: 'cancel_fork', operation: operation.operation }),
        ),
      );
    operations.append(row);
  }
}
document.querySelector('#workbench')!.addEventListener('workbench-preview', () => {
  previewActive = true;
  schedule();
});
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const raw = event.data;
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
  try {
    if (management.receive(raw)) return;
    if (raw.type === 'state') {
      const message = uiStateMessage.parse(raw);
      if (message.sequence <= sequence) return;
      const previousTurn = state?.view?.view?.active_turn;
      sequence = message.sequence;
      state = message.state;
      if (previousTurn && !state.view?.view?.active_turn) {
        send({ type: 'refresh_names' });
        if (titleRefreshTimer) window.clearTimeout(titleRefreshTimer);
        const session = state.selected;
        titleRefreshTimer = window.setTimeout(() => {
          if (state && state.selected === session && !state.view?.view?.active_turn)
            send({ type: 'refresh_names' });
        }, 16000);
      }
      for (const [session, previous] of pendingPrompts)
        if (
          state.error ||
          state.operations.some(
            (row) =>
              row.session === session &&
              row.method === 'prompt' &&
              !previous.has(row.operation) &&
              row.status !== 'pending',
          )
        )
          pendingPrompts.delete(session);
      schedule();
    } else if (
      raw.type === 'prompt_submitted' &&
      'session' in raw &&
      typeof raw.session === 'string' &&
      'generation' in raw &&
      typeof raw.generation === 'number' &&
      'operation' in raw &&
      typeof raw.operation === 'string'
    ) {
      if (raw.generation === draftGenerations.get(raw.session)) {
        if (promptOperations.size >= 64)
          promptOperations.delete(promptOperations.keys().next().value!);
        promptOperations.set(raw.session, { generation: raw.generation, operation: raw.operation });
      }
    } else if (
      raw.type === 'prompt_accepted' &&
      'session' in raw &&
      typeof raw.session === 'string' &&
      'prompt' in raw
    ) {
      const submitted = promptOperations.get(raw.session);
      if (
        !submitted ||
        !('operation' in raw) ||
        raw.operation !== submitted.operation ||
        !('generation' in raw) ||
        raw.generation !== submitted.generation
      )
        return;
      pendingPrompts.delete(raw.session);
      promptOperations.delete(raw.session);
      const text = raw.session === selected ? prompt.value : drafts.get(raw.session);
      try {
        if (
          'generation' in raw &&
          raw.generation === (draftGenerations.get(raw.session) || 0) &&
          JSON.stringify(raw.prompt) === JSON.stringify(composeDraft(raw.session, text))
        ) {
          if ('pi_after_seq' in raw && typeof raw.pi_after_seq === 'number') {
            pendingPiDrafts.set(raw.session, {
              generation: raw.generation as number,
              after: raw.pi_after_seq,
              text,
              attachments: attachmentDrafts.get(raw.session),
              image: inputImages.get(raw.session),
            });
            clearAcceptedDraft(raw.session);
          } else {
            clearAcceptedDraft(raw.session);
          }
        }
      } catch {
        /* Changed drafts are never cleared by an older acceptance. */
      }
      schedule();
    } else if (
      raw.type === 'attachments' &&
      'session' in raw &&
      raw.session === selected &&
      'files' in raw &&
      Array.isArray(raw.files)
    ) {
      try {
        touchDraft();
        attachmentDrafts.set(selected || '', [
          ...attachmentDrafts.get(selected || ''),
          ...raw.files,
        ]);
        persist();
        renderAttachments();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Invalid attachments';
      }
    } else if (raw.type === 'undo_result' && 'session' in raw && raw.session === state?.selected) {
      const report = (
        raw as unknown as {
          report: { files: { path: string; status: string; error?: string | null }[] };
        }
      ).report;
      const partial = report.files.some(
        (f) => f.status === 'uncertain' || f.status === 'not_attempted',
      );
      error.textContent = partial
        ? 'Undo partially completed; inspect each file and do not retry automatically.'
        : `Restored ${report.files.filter((f) => f.status === 'restored').length} files.`;
      schedule();
    } else if (raw.type === 'turn_diff' && 'session' in raw && raw.session === state?.selected) {
      const message = raw as unknown as {
        session: string;
        turn: string;
        offset?: number;
        diff: import('../src/workbench-protocol').TurnDiff;
      };
      diffReads.delete(`${message.session}:${message.turn}`);
      attemptedDiffs.delete(`${message.session}:${message.turn}`);
      if (
        message.session === state?.selected &&
        state?.view?.entries.some((row) => row.turn === message.turn)
      ) {
        const key = `${message.session}:${message.turn}`,
          previous = turnDiffs.get(key);
        if (message.offset && (!previous || previous.files.length !== message.offset)) return;
        const files =
          previous && message.offset
            ? [...previous.files, ...message.diff.files]
            : message.diff.files;
        if (files.length > 5000) return;
        turnDiffs.delete(key);
        turnDiffs.set(key, { ...message.diff, files });
        while (turnDiffs.size > 16) turnDiffs.delete(turnDiffs.keys().next().value!);
        schedule();
      }
    } else if (
      raw.type === 'turn_diff_content' &&
      'session' in raw &&
      raw.session === state?.selected
    ) {
      const m = raw as unknown as {
        session: string;
        turn: string;
        file: number;
        after: boolean;
        offset: number;
        bytes: string;
        total_bytes: number;
        next_offset?: number | null;
      };
      if (state?.view?.entries.some((row) => row.turn === m.turn)) {
        const key = `${m.session}:${m.turn}:${m.file}:${m.after}`,
          previous = diffContents.get(key);
        if (m.offset > 0 && (!previous || previous.nextOffset !== m.offset)) return;
        const text = m.offset && previous ? previous.text + m.bytes : m.bytes;
        if (text.length > 128 * 1024) return;
        diffContents.delete(key);
        diffContents.set(key, { text, nextOffset: m.next_offset });
        while (diffContents.size > 8) diffContents.delete(diffContents.keys().next().value!);
        schedule();
      }
    } else if (raw.type === 'turn_diff_error') {
      if ('session' in raw && 'turn' in raw) diffReads.delete(`${raw.session}:${raw.turn}`);
      if ('error' in raw && raw.error) error.textContent = String(raw.error);
      schedule();
    } else if (raw.type === 'selection_context' && 'file' in raw && selected) {
      try {
        attachmentDrafts.set(selected, [...attachmentDrafts.get(selected), raw.file]);
        touchDraft();
        persist();
        renderAttachments();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Invalid selection';
      }
    } else if (
      raw.type === 'draft' &&
      'text' in raw &&
      typeof raw.text === 'string' &&
      raw.text.length <= 200000
    ) {
      const next = prompt.value + `${prompt.value ? '\n\n' : ''}${raw.text}`;
      if (next.length <= prompt.maxLength) {
        prompt.value = next;
        touchDraft();
        saveDraft();
      } else error.textContent = 'Draft is too large; selection was not appended';
      prompt.focus();
    } else if (
      raw.type === 'image' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'asset' in raw
    ) {
      if ('request_id' in raw && typeof raw.request_id === 'number')
        pendingImages.delete(raw.request_id);
      const message = ipcMessage.parse({ type: 'image', id: 0, asset: raw.asset });
      if (message.type !== 'image') return;
      const asset = message.asset,
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
      if (!images.has(ref.id)) {
        while (imageBytes + ref.bytes > 32 * 1024 * 1024 && images.size) {
          const first = images.keys().next().value!;
          imageBytes -= images.get(first)!.asset.image.bytes;
          URL.revokeObjectURL(images.get(first)!.url);
          images.delete(first);
        }
        images.set(ref.id, {
          asset,
          url: URL.createObjectURL(
            new Blob([Uint8Array.from(bytes, (ch) => ch.charCodeAt(0))], { type: ref.mime }),
          ),
        });
        imageBytes += ref.bytes;
      }
      if ('request_id' in raw && typeof raw.request_id === 'number')
        pendingImages.delete(raw.request_id);
      else
        for (const [request_id, pending] of pendingImages)
          if (pending.image === ref.id && pending.session === raw.session)
            pendingImages.delete(request_id);
      imageErrors.delete(ref.id);
      schedule();
    } else if (
      raw.type === 'content' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'ref' in raw &&
      'slice' in raw &&
      'offset' in raw &&
      Number.isSafeInteger(raw.offset) &&
      Number(raw.offset) >= 0
    ) {
      const ref = contentRef.parse(raw.ref),
        slice = contentSlice.parse(raw.slice);
      const known =
        state?.view?.entries.some(
          (entry) => 'Archived' in entry.text && entry.text.Archived.content.id === ref.id,
        ) ||
        state?.view?.tools.some((tool) =>
          tool.content.some((body) =>
            'Text' in body
              ? body.Text.content.id === ref.id
              : 'ResourceText' in body
                ? body.ResourceText.content.id === ref.id
                : 'Diff' in body
                  ? body.Diff.old_text?.id === ref.id || body.Diff.new_text.id === ref.id
                  : false,
          ),
        );
      if (!known || slice.sha256 !== ref.sha256 || slice.total_bytes !== ref.bytes) return;
      contentPages.delete(ref.id);
      while (contentPages.size >= 4) contentPages.delete(contentPages.keys().next().value!);
      contentPages.set(ref.id, {
        ref,
        offset: Number(raw.offset),
        text: slice.text,
        next: slice.next_offset,
      });
      schedule();
    } else if (
      raw.type === 'content_error' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'ref' in raw
    ) {
      const ref = contentRef.parse(raw.ref);
      contentPages.delete(ref.id);
      schedule();
    } else if (
      raw.type === 'image_error' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'image' in raw &&
      typeof raw.image === 'string'
    ) {
      if ('request_id' in raw && typeof raw.request_id === 'number')
        pendingImages.delete(raw.request_id);
      else
        for (const [request_id, pending] of pendingImages)
          if (pending.image === raw.image && pending.session === raw.session)
            pendingImages.delete(request_id);
      imageErrors.set(raw.image, 'Archive unavailable');
      schedule();
    }
  } catch {
    error.textContent = 'Invalid workbench view message; refresh or reconnect';
  }
});
window.addEventListener('unload', () => {
  if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
  inputImages.clear();
  for (const image of images.values()) URL.revokeObjectURL(image.url);
  images.clear();
  contentPages.clear();
  turnDiffs.clear();
  diffContents.clear();
  pendingImages.clear();
});
send({ type: 'ready' });
