import { Submissions } from './workbench-submissions';
import { ImageView } from './workbench-image-view';
import { DiffView } from './workbench-diff-view';
import { ModelControls } from './workbench-model-controls';
import { installTooltips } from './tooltips';
import { installAltReleaseGuard } from './workbench-keyboard';
import { element, button } from './workbench-elements';
import { renderInteractions } from './workbench-interactions';
import { renderSettings } from './workbench-settings';
import { buildClassicShell, decorateIcon } from './workbench-shell';
import { createHistoryView } from './workbench-history-view';
import { reconcile } from './workbench-dom';
import { installComposerResize } from './composer-resize';
import { PaintScheduler } from './paint-scheduler';
import { Drafts } from './workbench-drafts';
import { Preferences } from './workbench-preferences';
import { ManagementPanel } from './workbench-management';
import { AttachmentDrafts } from './workbench-attachment-drafts';
import { composePrompt } from '../src/workbench-input';
import { createRenderer } from './markdown';
import {
  type ClientCommand,
  type ImageAsset,
  type ImageRef,
  type SessionView,
} from '../src/workbench-protocol';
import { uiMessage, type UiCommand, type WorkbenchUiState } from '../src/workbench-ui';

installAltReleaseGuard();

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
// VS Code webviews may route the native copy command to the focused composer.
// Send the actual document selection through the extension clipboard port.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c') return;
  const target = event.target;
  if (
    target instanceof window.HTMLElement &&
    target.closest('input, textarea, [contenteditable="true"]')
  )
    return;
  const text = window.getSelection()?.toString();
  if (!text) return;
  event.preventDefault();
  send({ type: 'copy_text', text });
});
let state: WorkbenchUiState | undefined,
  sequence = 0,
  selected: string | undefined;
let titleRefreshTimer: number | undefined;
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
// Native details change their open attribute before the browser dispatches toggle.
function saveDisclosures(records: MutationRecord[]) {
  let changed = false;
  for (const { target } of records) {
    if (!(target instanceof window.HTMLDetailsElement) || !target.isConnected) continue;
    const key = target.dataset.key;
    if (key && preferences.open(key, !target.open) !== target.open) {
      preferences.setOpen(key, target.open);
      changed = true;
    }
  }
  if (changed) persist();
}
const disclosureChanges = new window.MutationObserver(saveDisclosures);
disclosureChanges.observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
function disclosure(key: string, fallback = false) {
  const details = element('details');
  details.dataset.key = key;
  details.open = preferences.open(key, fallback);
  return details;
}
const submissions = new Submissions();
let inputHistory: { items: string[]; index: number; draft: string; caret: number } | undefined;
function clearAcceptedDraft(session: string) {
  inputImages.delete(session);
  attachmentDrafts.set(session, []);
  drafts.set(session, '');
  if (session === selected) {
    inputHistory = undefined;
    prompt.value = '';
    renderAttachments();
  }
  persist();
}
function settlePiDraft() {
  if (!selected) return;
  const result = submissions.settle(selected, state, hasDraftContent());
  if (result) {
    const { draft: pending, restore: unchanged } = result;
    if (unchanged) {
      drafts.set(selected, pending.text);
      inputHistory = undefined;
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
  if (session === selected) inputHistory = undefined;
  submissions.touch(session);
}
function saveDraft() {
  drafts.set(selected || '', inputHistory?.draft ?? prompt.value);
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
let historyReleaseConfirm: string | undefined;
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
let scrollOnPrompt: { session: string; revision: number } | undefined;
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
const earlierStatus = element('small');
earlierStatus.id = 'earlier-status';
earlierStatus.setAttribute('role', 'status');
earlierStatus.hidden = true;
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
    submissions.has(snapshot.id) ||
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
composerBox.append(prompt, composerTools, imagePicker);
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
  if (
    !choices.length &&
    current() &&
    prompt.value === '/' &&
    prompt.selectionStart === 1 &&
    !composing &&
    dismissedCommand !== '/' &&
    !current()?.catalogue.commands.length
  ) {
    const empty = element('div', '当前 Agent 尚未提供命令');
    empty.className = 'commands-empty';
    empty.setAttribute('role', 'option');
    empty.setAttribute('aria-disabled', 'true');
    completions.append(empty);
  }
  prompt.setAttribute('aria-expanded', String(completions.childElementCount > 0));
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
function recallInput(older: boolean) {
  if (!selected || current()?.id !== selected || state?.selected !== selected) return false;
  const caret = prompt.selectionStart;
  if (caret !== prompt.selectionEnd) return false;
  if (prompt.value.includes('\n') && caret !== (older ? 0 : prompt.value.length)) return false;
  if (!inputHistory) {
    if (!older) return false;
    const items = historyView.userInputs().filter((text) => text.length <= prompt.maxLength);
    if (!items.length) return false;
    inputHistory = { items, index: items.length, draft: prompt.value, caret };
  }
  const history = inputHistory;
  const index = history.index + (older ? -1 : 1);
  if (index < 0) return true;
  history.index = index;
  const restoring = index === history.items.length;
  prompt.value = restoring ? history.draft : history.items[index];
  const nextCaret = restoring
    ? history.caret
    : older && prompt.value.includes('\n')
      ? 0
      : prompt.value.length;
  prompt.setSelectionRange(nextCaret, nextCaret);
  if (restoring) inputHistory = undefined;
  submissions.touch(selected);
  dismissedCommand = restoring ? '' : prompt.value;
  renderCommands();
  updateSend();
  return true;
}
prompt.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229 || composing) return;
  if (event.key === 'Escape' && completions.childElementCount) {
    event.preventDefault();
    dismissedCommand = prompt.value;
    renderCommands();
    return;
  }
  if (commandChoices().length) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'ArrowDown') commandIndex = (commandIndex + 1) % commandChoices().length;
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
  if (
    (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    recallInput(event.key === 'ArrowUp')
  ) {
    event.preventDefault();
    return;
  }
  // Enter used to commit IME composition is not a send gesture.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!submit.disabled) composer.requestSubmit();
});
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const snapshot = current();
  if (!snapshot || submit.disabled || modelControls.busy || submissions.has(snapshot.id)) return;
  let text: ReturnType<typeof composePrompt>;
  try {
    text = composeDraft(snapshot.id, prompt.value);
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Invalid prompt';
    return;
  }
  let generation: number;
  try {
    generation = submissions.begin(snapshot.id, snapshot.harness, state?.operations ?? []);
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Cannot submit draft';
    return;
  }
  inputHistory = undefined;
  saveDraft();
  submit.disabled = true;
  classic.scrollToBottom();
  send({
    type: 'execute',
    session: snapshot.id,
    command: { method: 'prompt', session: snapshot.id, prompt: text },
    generation,
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
  historyStatus: earlierStatus,
  management: management.root,
  settings,
  plan: planPanel,
  transcript,
  interactions,
  operations,
  composer,
  completions,
  advanced,
  historyOpen: preferences.historyOpen,
  onLatest: () => {
    const snapshot = current();
    if (snapshot && (state?.view?.historical || state?.view?.loadingEarlier)) {
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
const imageView = new ImageView(() => state, send, schedule);
const diffView = new DiffView(() => state, send, disclosure, error, schedule);
const historyView = createHistoryView({
  transcript,
  messages,
  preferences,
  disclosure,
  diffView,
  imageView,
  markdown,
  send,
  mutate,
  getState: () => state,
  schedule,
  reusePrompt(text) {
    const next = prompt.value ? `${prompt.value}\n\n${text}` : text;
    if (next.length > prompt.maxLength) {
      error.textContent = 'Combined draft exceeds the prompt budget';
      return;
    }
    prompt.value = next;
    touchDraft();
    saveDraft();
    prompt.focus();
  },
});
function current() {
  return state?.view?.view;
}
function mutate(command: ClientCommand) {
  const snapshot = current();
  if (snapshot) send({ type: 'execute', session: snapshot.id, command });
}
const paintScheduler = new PaintScheduler(() => {
  const start = performance.now();
  render();
  performance.measure('workbench.render', { start });
  // Keep instrumentation bounded in a long-lived view.
  if (performance.getEntriesByName('workbench.render').length > 2048)
    performance.clearMeasures('workbench.render');
});
function schedule(streaming = false) {
  paintScheduler.request(
    streaming,
    `${state?.selected || ''}:${state?.view?.view?.active_turn || ''}`,
  );
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
function renderPlan(snapshot: SessionView) {
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
}
function render() {
  saveDisclosures(disclosureChanges.takeRecords());
  if (!state) return;
  const earlierLoaded = state.view?.earlierLoaded;
  const historyFeedback =
    state.view?.earlierError ??
    (state.view?.loadingEarlier
      ? earlierLoaded
        ? `正在加载更早消息，已加载 ${earlierLoaded} 轮…`
        : '正在加载更早消息…'
      : earlierLoaded === undefined
        ? ''
        : earlierLoaded > 0
          ? `已加载 ${earlierLoaded} 轮更早消息，向上滚动查看。`
          : '没有更早的消息了。');
  if (earlierStatus.textContent !== historyFeedback) earlierStatus.textContent = historyFeedback;
  earlierStatus.hidden = !historyFeedback;
  if (selected !== state.selected) {
    jumpToLatest = false;
    if (scrollOnPrompt?.session !== state.selected) scrollOnPrompt = undefined;
    saveDraft();
    inputHistory = undefined;
    selected = state.selected;
    prompt.value = drafts.get(selected || '');
    renderAttachments();
    imageView.clear();
    historyView.clear();
    diffView.clear();

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
        send({ type: 'remove_session', session: session.id });
      },
      !state.trusted,
    );
    removeHistory.className = 'history-delete';
    removeHistory.setAttribute('aria-label', `删除会话：${session.title || session.id}`);
    removeHistory.title = '删除会话（保留原生数据）';
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
  imageView.retain(visibleImages);
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
    historical: state.view?.historical || state.view?.loadingEarlier,
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
  submit.disabled = busy || submissions.has(snapshot?.id || '') || !hasDraftContent();
  submit.setAttribute(
    'aria-label',
    submissions.has(snapshot?.id || '') ? '正在确认发送…' : '发送消息',
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
  renderCommands();
  management.setView(snapshot, state.sessions, state.operations, state.error);
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
    workingLabel.textContent = `${snapshot.harness === 'Pi' ? 'Pi Agent' : snapshot.harness} 正在处理…`;
    const follow = preferences.autoScroll && classic.nearBottom();
    renderPlan(snapshot);
    const prepended = historyView.render(snapshot, busy);
    renderInteractions(interactions, snapshot, mutate);
    const promptArrived =
      scrollOnPrompt?.session === snapshot.id && snapshot.revision >= scrollOnPrompt.revision;
    const latestArrived =
      jumpToLatest &&
      !state.view?.historical &&
      !state.view?.loadingEarlier &&
      state.view?.status === 'ready';
    if (promptArrived || latestArrived || (follow && !prepended)) classic.scrollToBottom();
    if (promptArrived) scrollOnPrompt = undefined;
    if (latestArrived) jumpToLatest = false;
  } else {
    modelControls.show(false);
    renderContextUsage();
    settings.replaceChildren();
    viewOptions.replaceChildren();
    delete settings.dataset.definition;
    planPanel.replaceChildren();
    delete planPanel.dataset.definition;
    working.hidden = true;
    historyView.clear();
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
  classic.updateBottom();
}
document.querySelector('#workbench')!.addEventListener('workbench-preview', () => {
  previewActive = true;
  schedule();
});
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  try {
    const raw = uiMessage.parse(event.data);
    if (raw.type === 'content' || raw.type === 'content_error') {
      historyView.receive(raw);
      return;
    }
    if (management.receive(raw)) return;
    if (raw.type === 'image' || raw.type === 'image_error') {
      imageView.receive(raw);
      return;
    }
    if (['undo_result', 'turn_diff', 'turn_diff_content', 'turn_diff_error'].includes(raw.type)) {
      diffView.receive(raw);
      return;
    }
    if (raw.type === 'state') {
      const message = raw;
      if (message.sequence <= sequence) return;
      const previousTurn = state?.view?.view?.active_turn;
      const historyFeedbackChanged =
        state?.view?.loadingEarlier !== message.state.view?.loadingEarlier ||
        state?.view?.earlierLoaded !== message.state.view?.earlierLoaded ||
        state?.view?.earlierError !== message.state.view?.earlierError;
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
      submissions.observe(state);
      schedule(
        !historyFeedbackChanged &&
          state.view?.status === 'ready' &&
          state.view.view?.status === 'Running',
      );
    } else if (raw.type === 'prompt_submitted') {
      submissions.submitted(raw);
    } else if (raw.type === 'prompt_accepted') {
      const result = submissions.accept(raw, () => {
        const text = raw.session === selected ? prompt.value : drafts.get(raw.session);
        return {
          prompt: composeDraft(raw.session, text),
          draft: {
            text,
            attachments: attachmentDrafts.get(raw.session),
            image: inputImages.get(raw.session),
          },
        };
      });
      if (!result.matched) return;
      if (raw.session === state?.selected && raw.revision !== undefined)
        scrollOnPrompt = { session: raw.session, revision: raw.revision };
      if (result.clear) clearAcceptedDraft(raw.session);
      schedule();
    } else if (raw.type === 'attachments' && raw.session === selected) {
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
    } else if (raw.type === 'selection_context' && selected) {
      try {
        attachmentDrafts.set(selected, [...attachmentDrafts.get(selected), raw.file]);
        touchDraft();
        persist();
        renderAttachments();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Invalid selection';
      }
    } else if (raw.type === 'draft') {
      const next = prompt.value + `${prompt.value ? '\n\n' : ''}${raw.text}`;
      if (next.length <= prompt.maxLength) {
        prompt.value = next;
        touchDraft();
        saveDraft();
      } else error.textContent = 'Draft is too large; selection was not appended';
      prompt.focus();
    }
  } catch {
    error.textContent = 'Invalid workbench view message; refresh or reconnect';
  }
});
window.addEventListener('unload', () => {
  saveDisclosures(disclosureChanges.takeRecords());
  disclosureChanges.disconnect();
  if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
  inputImages.clear();
  imageView.clear();
  historyView.clear();
  diffView.clear();
});
send({ type: 'ready' });
