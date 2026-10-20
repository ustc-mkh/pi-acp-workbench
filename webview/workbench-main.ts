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
const pendingPiDrafts = new Map<string, { generation: number; after: number }>();
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
    error.textContent = 'Pi is working autonomously. Input was not sent; draft preserved.';
  } else if (pending.generation === (draftGenerations.get(selected) || 0)) {
    clearAcceptedDraft(selected);
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
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, click: () => void, disabled = false) {
  const node = element('button', label);
  node.type = 'button';
  node.disabled = disabled;
  node.onclick = click;
  return node;
}
const management = new ManagementPanel(send, schedule);
const header = element('header'),
  title = element('h1', 'Pi Workbench');
const harness = element('select');
harness.setAttribute('aria-label', 'New session provider');
for (const name of ['Pi', 'Codex', 'Claude']) {
  const option = element('option', name);
  option.value = name;
  harness.append(option);
}
header.append(
  title,
  harness,
  button('New session', () => {
    if (!state?.workspace) return;
    send({
      type: 'create',
      command: {
        method: 'create',
        harness: harness.value as 'Pi' | 'Codex' | 'Claude',
        cwd: state.workspace,
      },
    });
  }),
  button('Refresh', () => send({ type: 'refresh' })),
  button('Provider login…', () => send({ type: 'login' })),
  button('Usage statistics', () => management.openStatistics()),
  button('Model settings', () => management.openModels()),
  button('Telegram setup', () => send({ type: 'configure_telegram' })),
  button('Export Markdown', () => {
    if (state?.selected) send({ type: 'export', session: state.selected as SessionView['id'] });
  }),
);
const sessions = element('select');
sessions.setAttribute('aria-label', 'Session');
sessions.addEventListener('change', () => {
  const session = state?.sessions.find((item) => item.id === sessions.value);
  if (session) send({ type: 'select', session: session.id });
});
const status = element('p'),
  error = element('p'),
  settings = element('section'),
  planPanel = element('section'),
  transcript = element('section');
planPanel.id = 'plan';
planPanel.setAttribute('aria-label', 'Session plan');
error.setAttribute('role', 'alert');
status.setAttribute('role', 'status');
transcript.id = 'transcript';
const interactions = element('section'),
  operations = element('section');
interactions.id = 'interactions';
operations.id = 'operations';
const composer = element('form'),
  prompt = element('textarea');
prompt.id = 'prompt';
prompt.setAttribute('aria-label', 'Prompt');
prompt.placeholder = 'Send text, explicit context, or one image (PNG/JPEG/WebP; up to 4 MiB)';
prompt.rows = 4;
prompt.maxLength = 200000;
prompt.disabled = true;
const submit = element('button', 'Send');
submit.type = 'submit';
submit.disabled = true;
const cancel = button('Cancel turn', () => mutate({ method: 'cancel', session: current()!.id }));
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
resize.setAttribute('aria-label', 'Resize composer');
resize.setAttribute('aria-orientation', 'horizontal');
installComposerResize(resize, prompt, preferences.composerHeight, (height) => {
  preferences.composerHeight = height;
  persist();
});
const completions = element('div');
completions.id = 'commands';
completions.setAttribute('role', 'listbox');
completions.setAttribute('aria-label', 'Provider commands');
composer.append(
  attachments,
  resize,
  completions,
  prompt,
  attach,
  attachImage,
  imagePicker,
  submit,
  cancel,
);
let inputPreviewUrl: string | undefined;
function renderAttachments() {
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
  if (!snapshot || submit.disabled || pendingPrompts.has(snapshot.id)) return;
  let text: ReturnType<typeof composePrompt>;
  try {
    text = composeDraft(snapshot.id, prompt.value);
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Invalid prompt';
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
root.append(
  header,
  sessions,
  status,
  error,
  management.root,
  settings,
  planPanel,
  transcript,
  interactions,
  operations,
  composer,
);
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
function renderSettings(snapshot: SessionView, busy: boolean) {
  const definition = JSON.stringify([
    snapshot.id,
    snapshot.catalogue,
    snapshot.catalogue.models.map((choice) => management.visible(choice.id, snapshot.harness)),
    busy,
    preferences.showThoughts,
    preferences.autoScroll,
    preferences.sessionRows,
  ]);
  if (settings.dataset.definition === definition) return;
  settings.dataset.definition = definition;
  settings.replaceChildren();
  settings.append(
    button(
      'Discover provider settings',
      () => mutate({ method: 'discover', session: snapshot.id }),
      busy,
    ),
  );
  for (const setting of snapshot.catalogue.selects || []) {
    if (
      setting.category === 'model' ||
      setting.category === 'mode' ||
      setting.id === 'model' ||
      setting.id === 'mode'
    )
      continue;
    const label = element('label', setting.name);
    const select = element('select');
    select.setAttribute('aria-label', setting.name);
    select.disabled = busy;
    for (const choice of setting.choices) {
      const option = element('option', choice.name);
      option.value = choice.value;
      select.append(option);
    }
    select.value = setting.current_value;
    select.onchange = () =>
      mutate({ method: 'set_option', session: snapshot.id, id: setting.id, value: select.value });
    label.append(select);
    settings.append(label);
  }
  for (const key of ['model', 'mode'] as const) {
    const choices = key === 'model' ? snapshot.catalogue.models : snapshot.catalogue.modes;
    const select = element('select');
    select.setAttribute('aria-label', key);
    select.disabled = busy;
    const unknown = element('option', `Select ${key}`);
    unknown.value = '';
    select.append(unknown);
    for (const choice of choices) {
      if (
        key === 'model' &&
        choice.id !== snapshot.catalogue.current_model &&
        !management.visible(choice.id, snapshot.harness)
      )
        continue;
      const option = element('option', choice.name);
      option.value = choice.id;
      select.append(option);
    }
    select.value =
      (key === 'model' ? snapshot.catalogue.current_model : snapshot.catalogue.current_mode) || '';
    select.addEventListener('change', () => {
      const value = choices.find((choice) => choice.id === select.value);
      if (!value) return;
      mutate(
        key === 'model'
          ? {
              method: 'set_model',
              session: snapshot.id,
              model: value.id as NonNullable<SessionView['config']['model']>,
            }
          : {
              method: 'set_mode',
              session: snapshot.id,
              mode: value.id as NonNullable<SessionView['config']['mode']>,
            },
      );
    });
    settings.append(select);
  }
  const thoughtLabel = element('label', 'Show thoughts');
  const showThoughts = element('input');
  showThoughts.type = 'checkbox';
  showThoughts.checked = preferences.showThoughts;
  showThoughts.addEventListener('change', () => {
    preferences.showThoughts = showThoughts.checked;
    persist();
    schedule();
  });
  thoughtLabel.prepend(showThoughts);
  settings.append(thoughtLabel);
  const autoScroll = element('input');
  autoScroll.type = 'checkbox';
  autoScroll.checked = preferences.autoScroll;
  autoScroll.onchange = () => {
    preferences.autoScroll = autoScroll.checked;
    persist();
  };
  const scrollLabel = element('label', 'Follow latest output');
  scrollLabel.prepend(autoScroll);
  const rows = element('select');
  rows.setAttribute('aria-label', 'Session list rows');
  for (const i of [4, 10, 16]) {
    const option = element('option', `${i} session rows`);
    option.value = String(i);
    rows.append(option);
  }
  rows.value = String(preferences.sessionRows);
  rows.onchange = () => {
    preferences.sessionRows = Number(rows.value);
    persist();
    schedule();
  };
  settings.append(scrollLabel, rows);
  let confirmRemove = false;
  const remove = button(
    'Remove session',
    () => {
      if (!confirmRemove) {
        confirmRemove = true;
        remove.textContent = 'Confirm remove (native provider data is retained)';
        return;
      }
      mutate({ method: 'remove', session: snapshot.id });
    },
    !state?.trusted,
  );
  settings.append(remove);
  if (snapshot.usage.context_size != null)
    settings.append(
      element(
        'p',
        `Context ${snapshot.usage.context_used ?? '?'} / ${snapshot.usage.context_size}`,
      ),
    );
  settings.append(
    element(
      'p',
      `Tokens: ${snapshot.usage.input_tokens} input / ${snapshot.usage.output_tokens} output`,
    ),
  );
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
  output.append(
    button(
      'Load earlier (keep current messages)',
      () => send({ type: 'earlier', session: snapshot.id }),
      !state?.view?.earlier,
    ),
  );
  output.append(button('Latest page', () => send({ type: 'latest', session: snapshot.id })));
  output.append(
    element(
      'small',
      `${rows.length} confirmed entries · ${state?.view?.historical ? 'history window' : 'latest window'}${state?.view?.earlier ? ' · Earlier content is not loaded; the first message may be a continuation. Load earlier, copy or export for complete messages.' : ''}`,
    ),
  );
  for (const message of messageProjection.update(rows)) {
    const row =
      message.inlineText !== undefined
        ? { ...message.row, text: { Inline: { text: message.inlineText } } }
        : message.row;
    let turn = turns.get(row.turn);
    if (!turn) {
      const box = element('section');
      box.dataset.turn = row.turn;
      box.className = 'turn';
      const process = disclosure(
        `${snapshot.id}:turn:${row.turn}`,
        snapshot.active_turn === row.turn,
      );
      process.className = 'turn-process';
      process.append(element('summary', 'Thoughts and tools'));
      box.append(element('h2', `Turn · ${row.turn}`), process);
      box.append(
        button('Review workspace changes', () =>
          send({ type: 'read_turn_diff', session: snapshot.id, turn: row.turn }),
        ),
      );
      const savedDiff = turnDiffs.get(`${snapshot.id}:${row.turn}`);
      if (savedDiff) {
        const summary = disclosure(`${snapshot.id}:diff:${row.turn}`, false);
        summary.append(
          element(
            'summary',
            `${savedDiff.status} · +${savedDiff.added} −${savedDiff.removed} lines`,
          ),
        );
        if (savedDiff.status === 'complete' && savedDiff.files.length)
          box.append(
            button(
              'Undo this turn…',
              () =>
                send({
                  type: 'execute',
                  session: snapshot.id,
                  command: { method: 'undo_turn', session: snapshot.id, turn: row.turn },
                }),
              busy || snapshot.status !== 'Idle',
            ),
          );
        summary.append(
          button('View total Diff in editor', () =>
            send({ type: 'open_turn_diff', session: snapshot.id, turn: row.turn }),
          ),
        );
        summary.append(
          element(
            'p',
            'Net workspace snapshots include concurrent edits. Ignored files and external/background processes are outside the guarantee. Undo does not rewind model context.',
          ),
        );
        if (!savedDiff.files.length) summary.append(element('p', 'No captured workspace changes.'));
        for (const [index, file] of savedDiff.files.entries()) {
          summary.append(element('h3', `${file.status} · ${file.path}`));
          if (file.old_mode !== file.new_mode)
            summary.append(
              element(
                'p',
                `Permissions: ${file.old_mode?.toString(8) ?? 'absent'} → ${file.new_mode?.toString(8) ?? 'absent'}`,
              ),
            );
          summary.append(
            button('Compare file in editor', () =>
              send({ type: 'open_turn_diff', session: snapshot.id, turn: row.turn, file: index }),
            ),
          );
          if (file.omitted) {
            summary.append(element('p', file.omitted));
            for (const after of [false, true])
              if ((after ? file.after : file.before) === null)
                summary.append(
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
              summary.append(pre);
              if (loaded.text.length > 30000 || loaded.text.split('\n').length > 400)
                summary.append(
                  element(
                    'p',
                    'Inline preview truncated; open the editor diff for full saved text.',
                  ),
                );
              if (
                loaded.text.length < 30000 &&
                loaded.nextOffset !== null &&
                loaded.nextOffset !== undefined
              )
                summary.append(
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
          if (file.before !== null) {
            summary.append(element('h4', 'Before'));
            const pre = element('pre');
            pre.textContent = file.before ?? '';
            summary.append(pre);
          }
          if (file.after !== null) {
            summary.append(element('h4', 'After'));
            const pre = element('pre');
            pre.textContent = file.after ?? '';
            summary.append(pre);
          }
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
        for (const warning of savedDiff.warnings) summary.append(element('p', warning));
        box.append(summary);
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
        'Archived' in entry.text ? [contentPages.get(entry.text.Archived.content.id)] : [],
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
      if (row.role === 'Thought') turn.process.append(placeholder);
      else if (row.role === 'User') turn.box.insertBefore(placeholder, turn.process);
      else turn.box.append(placeholder);
      continue;
    }
    const article = element('article');
    article.dataset.definition = definition;
    article.dataset.entry = message.key;
    article.className = row.role.toLowerCase();
    article.append(element('small', `${row.role} · ${row.seq}`));
    article.append(
      button('Copy message', () =>
        send({ type: 'copy_message', session: snapshot.id, entry: row.id }),
      ),
    );
    if (row.role === 'User' && !row.image && 'Inline' in row.text) {
      const text = row.text.Inline.text;
      article.append(
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
    if ('Inline' in row.text) {
      // Streaming text stays cheap and selectable. Parse only geometrically growing
      // prefixes; the unparsed tail remains visible until the next checkpoint/end.
      const text = row.text.Inline.text;
      const active = row.role !== 'User' && snapshot.active_turn === row.turn;
      const checkpoint = active
        ? Math.min(128 * 1024, 2 ** Math.floor(Math.log2(Math.max(1, text.length))))
        : Math.min(text.length, 256 * 1024);
      const parsed = element('div');
      parsed.dataset.markdown = 'true';
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
              copy.textContent = 'Copied';
            },
            () => {
              copy.textContent = 'Copy unavailable';
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
      details.append(element('summary', 'Thought'), content);
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
      article.append(fork);
    }
    if (row.role === 'Thought') turn.process.append(article);
    else if (row.role === 'User') turn.box.insertBefore(article, turn.process);
    else turn.box.append(article);
  }
  const visibleTurns = new Set(rows.map((row) => row.turn));
  for (const turn of visibleTurns)
    turns
      .get(turn)!
      .process.append(
        button(`Tools for ${turn}`, () => send({ type: 'read_tools', session: snapshot.id, turn })),
      );
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
      plan.append(element('summary', 'Plan'));
      for (const item of snapshot.plan.items) {
        const line = element('p', `${item.status}: ${item.description}`);
        line.dataset.status = item.status;
        plan.append(line);
      }
      planPanel.append(plan);
    }
  }
  reconcile(transcript, output);
  for (const fork of transcript.querySelectorAll<HTMLButtonElement>('[data-fork]'))
    fork.disabled = busy || snapshot.status !== 'Idle';
  const restored = [...transcript.querySelectorAll<HTMLElement>('[data-entry]')].find(
    (node) => node.dataset.entry === anchorId,
  );
  transcript.scrollTop =
    bottom && preferences.autoScroll
      ? transcript.scrollHeight
      : restored && anchorOffset !== undefined
        ? scroll + restored.getBoundingClientRect().top - anchorOffset
        : scroll;
}
function renderInteractions(snapshot: SessionView) {
  // Preserve partially entered answers across streaming/snapshot refresh. A
  // definition change must replace that form; answered/expired IDs disappear.
  const existing = new Map(
    [...interactions.children].map((child) => [child.getAttribute('data-interaction'), child]),
  );
  const retained = new Set<string>();
  for (const interaction of Object.values(snapshot.pending_interactions)) {
    const signature = JSON.stringify(interaction),
      old = existing.get(interaction.id);
    retained.add(interaction.id);
    if (old?.getAttribute('data-definition') === signature) continue;
    old?.remove();
    const box = element('form');
    box.dataset.interaction = interaction.id;
    box.dataset.definition = signature;
    box.append(element('h2', interaction.title), element('p', interaction.detail));
    const answer = (response: Parameters<typeof mutate>[0] & { method: 'answer' }) =>
      mutate(response);
    if (interaction.kind === 'Permission') {
      for (const option of interaction.options)
        box.append(
          button(option.label, () =>
            answer({
              method: 'answer',
              session: snapshot.id,
              answer: {
                interaction: interaction.id,
                response: { Permission: { option: option.id } },
              },
            }),
          ),
        );
    } else {
      type FieldValue = Extract<
        import('../src/workbench-protocol').InteractionAnswer['response'],
        { Form: unknown }
      >['Form']['fields'][string];
      const inputs: { name: string; get(): FieldValue | undefined }[] = [];
      for (const field of interaction.fields) {
        const label = element('label', field.label),
          kind = field.kind;
        if (kind === 'Boolean') {
          const input = element('input');
          input.type = 'checkbox';
          label.append(input);
          inputs.push({ name: field.name, get: () => ({ Boolean: input.checked }) });
        } else if ('Text' in kind) {
          const input = element('textarea');
          input.required = field.required;
          input.maxLength = kind.Text.max_length;
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => (input.value || field.required ? { Text: input.value } : undefined),
          });
        } else if ('Choice' in kind) {
          const input = element('select');
          input.multiple = kind.Choice.multiple;
          input.required = field.required;
          if (!field.required && !input.multiple) {
            const empty = element('option', 'No selection');
            empty.value = '';
            input.append(empty);
          }
          for (const option of kind.Choice.options) {
            const node = element('option', option.label);
            node.value = option.id;
            input.append(node);
          }
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => ({
              Selected: [...input.selectedOptions].map((option) => option.value).filter(Boolean),
            }),
          });
        } else {
          const input = element('input');
          input.type = 'number';
          input.step = '1';
          input.required = field.required;
          if (kind.Integer.min !== null) input.min = String(kind.Integer.min);
          if (kind.Integer.max !== null) input.max = String(kind.Integer.max);
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => (input.value ? { Integer: Number(input.value) } : undefined),
          });
        }
        box.append(label);
      }
      const submit = element('button', 'Submit answer');
      submit.type = 'submit';
      box.append(submit);
      box.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!box.reportValidity()) return;
        const fields: Record<string, FieldValue> = Object.create(null);
        for (const input of inputs) {
          const value = input.get();
          if (value !== undefined) fields[input.name] = value;
        }
        answer({
          method: 'answer',
          session: snapshot.id,
          answer: { interaction: interaction.id, response: { Form: { fields } } },
        });
      });
    }
    box.append(
      button('Decline', () =>
        answer({
          method: 'answer',
          session: snapshot.id,
          answer: { interaction: interaction.id, response: 'Decline' },
        }),
      ),
    );
    interactions.append(box);
  }
  for (const [id, child] of existing) if (!id || !retained.has(id)) child.remove();
}
function render() {
  if (!state) return;
  if (selected !== state.selected) {
    saveDraft();
    selected = state.selected;
    prompt.value = drafts.get(selected || '');
    renderAttachments();
    for (const image of images.values()) URL.revokeObjectURL(image.url);
    images.clear();
    contentPages.clear();
    turnDiffs.clear();
    diffContents.clear();
    imageBytes = 0;
    imageErrors.clear();
    pendingImages.clear();
    interactions.replaceChildren();
    planPanel.replaceChildren();
    delete planPanel.dataset.definition;
    transcript.scrollTop = 0;
  }
  sessions.replaceChildren(element('option', 'Select session'));
  for (const session of state.sessions) {
    const phase = typeof session.status === 'string' ? session.status : 'Failed';
    const option = element(
      'option',
      `#${session.created_seq} · ${session.title ?? session.id} · ${session.harness} · ${phase} · ${session.cwd}`,
    );
    option.value = session.id;
    sessions.append(option);
  }
  // A restored/active session need not be in the currently listed cold page.
  const selectedView = current();
  if (selectedView && !state.sessions.some((session) => session.id === selectedView.id)) {
    const option = element(
      'option',
      `${selectedView.harness} · ${selectedView.id} · ${selectedView.cwd} (selected, outside this page)`,
    );
    option.value = selectedView.id;
    sessions.append(option);
  }
  sessions.value = state.selected || '';
  document.querySelector('[data-session-page]')?.remove();
  const nextSessions = state.sessionsCursor;
  if (nextSessions) {
    const page = element('span');
    page.dataset.sessionPage = 'true';
    page.append(button('Next session page', () => send({ type: 'refresh', cursor: nextSessions })));
    page.append(button('Latest session page', () => send({ type: 'refresh' })));
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
    (snapshot && typeof snapshot.status === 'object' ? snapshot.status.Failed : '');
  settlePiDraft();
  status.textContent = `${state.view?.status || 'Select or create a session'}${snapshot ? ` · ${typeof snapshot.status === 'string' ? snapshot.status : 'Failed'} · revision ${snapshot.revision}` : ''}${!state.trusted ? ' · workspace untrusted' : ''}`;
  const busy =
    !snapshot || !state.trusted || state.view?.status !== 'ready' || snapshot.active_turn !== null;
  submit.disabled = busy || pendingPrompts.has(snapshot?.id || '');
  submit.textContent = pendingPrompts.has(snapshot?.id || '') ? 'Confirming acceptance…' : 'Send';
  prompt.disabled = !snapshot;
  attach.disabled = !snapshot || !state.trusted;
  attachImage.disabled = !snapshot || !state.trusted;
  cancel.disabled =
    !snapshot || !state.trusted || (snapshot.active_turn === null && snapshot.harness !== 'Pi');
  cancel.textContent = snapshot?.active_turn ? 'Cancel turn' : 'Stop Pi background worker';
  if (snapshot) {
    management.setView(snapshot, state.sessions, state.operations);
    sessions.size = preferences.sessionRows;
    renderSettings(snapshot, busy);
    renderTranscript(snapshot, busy);
    renderInteractions(snapshot);
  } else {
    settings.replaceChildren();
    delete settings.dataset.definition;
    planPanel.replaceChildren();
    delete planPanel.dataset.definition;
    transcript.replaceChildren();
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
            if (pendingPiDrafts.size >= 64)
              pendingPiDrafts.delete(pendingPiDrafts.keys().next().value!);
            pendingPiDrafts.set(raw.session, {
              generation: raw.generation as number,
              after: raw.pi_after_seq,
            });
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
      error.textContent = 'Workspace diff unavailable';
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
