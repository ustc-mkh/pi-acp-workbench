import { Drafts } from './workbench-drafts';
import { Preferences } from './workbench-preferences';
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
let nextUiRequest = 0;
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
  details.open = preferences.open(key, fallback);
  details.addEventListener('toggle', () => {
    if (!details.isConnected || details.open === preferences.open(key, fallback)) return;
    preferences.setOpen(key, details.open);
    persist();
  });
  return details;
}
const pendingPrompts = new Map<string, Set<string>>();
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
  node.addEventListener('click', click);
  return node;
}
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
prompt.placeholder = 'Send a text prompt (images as input are not yet supported)';
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
const attach = button('Attach files', () => {
  const snapshot = current();
  if (snapshot) send({ type: 'attach_files', session: snapshot.id });
});
composer.append(attachments, prompt, attach, submit, cancel);
function renderAttachments() {
  attachments.replaceChildren();
  for (const file of attachmentDrafts.get(selected || '')) {
    const details = disclosure(`${selected}:attachment:${file.id}`);
    details.append(element('summary', `${file.name} · ${file.text.length} characters`));
    details.append(element('pre', file.text));
    details.append(
      button(`Remove attachment ${file.name}`, () => {
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
prompt.addEventListener('input', saveDraft);
prompt.addEventListener('keydown', (event) => {
  // Enter used to commit IME composition is not a send gesture.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!submit.disabled) composer.requestSubmit();
});
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const snapshot = current();
  if (!snapshot || submit.disabled || pendingPrompts.has(snapshot.id)) return;
  let text: string;
  try {
    text = composePrompt(prompt.value, attachmentDrafts.get(snapshot.id));
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : 'Invalid prompt';
    return;
  }
  if (pendingPrompts.size >= 16) {
    error.textContent = 'Too many pending input receipts; check operations before sending.';
    return;
  }
  saveDraft();
  pendingPrompts.set(
    snapshot.id,
    new Set(state?.operations.map((operation) => operation.operation)),
  );
  submit.disabled = true;
  mutate({ method: 'prompt', session: snapshot.id, prompt: text });
});
root.append(
  header,
  sessions,
  status,
  error,
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
    render();
  });
}
function renderSettings(snapshot: SessionView, busy: boolean) {
  settings.replaceChildren();
  for (const key of ['model', 'mode'] as const) {
    const choices = key === 'model' ? snapshot.catalogue.models : snapshot.catalogue.modes;
    const select = element('select');
    select.setAttribute('aria-label', key);
    select.disabled = busy;
    const unknown = element('option', `Select ${key}`);
    unknown.value = '';
    select.append(unknown);
    for (const choice of choices) {
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
  transcript.replaceChildren();
  const turns = new Map<string, { box: HTMLElement; process: HTMLDetailsElement }>();
  transcript.append(
    button(
      'Earlier page',
      () => send({ type: 'earlier', session: snapshot.id }),
      !state?.view?.earlier,
    ),
  );
  transcript.append(button('Latest page', () => send({ type: 'latest', session: snapshot.id })));
  transcript.append(
    element(
      'small',
      `${rows.length} confirmed entries · ${state?.view?.historical ? 'historical page' : 'latest page'}`,
    ),
  );
  for (const row of rows) {
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
      turn = { box, process };
      turns.set(row.turn, turn);
      transcript.append(box);
    }
    if (row.role === 'Thought' && !preferences.showThoughts) continue;
    const definition = JSON.stringify([
      row,
      busy,
      snapshot.status,
      'Archived' in row.text ? contentPages.get(row.text.Archived.content.id) : null,
      row.image
        ? [
            images.get(row.image.id)?.url,
            imageErrors.get(row.image.id),
            [...pendingImages.values()].some((pending) => pending.image === row.image?.id),
            pendingImages.size >= 4,
          ]
        : null,
    ]);
    const previous = previousArticles.get(row.id);
    if (previous?.dataset.definition === definition) {
      if (row.role === 'Thought') turn.process.append(previous);
      else if (row.role === 'User') turn.box.insertBefore(previous, turn.process);
      else turn.box.append(previous);
      continue;
    }
    const article = element('article');
    article.dataset.definition = definition;
    article.dataset.entry = row.id;
    article.className = row.role.toLowerCase();
    article.append(element('small', `${row.role} · ${row.seq}`));
    const content = element('div');
    if ('Inline' in row.text) {
      content.innerHTML = markdown(row.text.Inline.text);
      content
        .querySelectorAll('a')
        .forEach((link) => link.addEventListener('click', (event) => event.preventDefault()));
      for (const copy of content.querySelectorAll<HTMLButtonElement>('.copy-code'))
        copy.addEventListener('click', () => {
          const text = copy.parentElement?.querySelector('code')?.textContent ?? '';
          void window.navigator.clipboard?.writeText(text).then(
            () => {
              copy.textContent = 'Copied';
            },
            () => {
              copy.textContent = 'Copy unavailable';
            },
          );
        });
      if (content.querySelector('.mermaid-diagram')) {
        const draw = button('Render diagrams', () => {
          draw.disabled = true;
          void renderDiagrams(content).finally(() => {
            draw.disabled = false;
          });
        });
        content.prepend(draw);
      }
    } else content.append(contentNode(row.text.Archived.content, snapshot.id));
    if (row.role === 'Thought') {
      const details = disclosure(`${snapshot.id}:thought:${row.id}`);
      details.append(element('summary', 'Thought'), content);
      article.append(details);
    } else article.append(content);
    if (row.image) article.append(imageNode(row.image, snapshot.id));
    if (['Agent', 'User'].includes(row.role) && !row.image)
      article.append(
        button(
          'Fork here',
          () => mutate({ method: 'fork', session: snapshot.id, request: { entry: row.id } }),
          busy || snapshot.status !== 'Idle',
        ),
      );
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
    transcript.append(
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
          element('p', `Terminal reference: ${body.TerminalReference.id} (display only)`),
        );
      else details.append(element('p', `Unsupported binary: ${body.Unsupported.kind}`));
    }
    turns.get(tool.turn)!.process.append(details);
  }
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
  const restored = [...transcript.querySelectorAll<HTMLElement>('[data-entry]')].find(
    (node) => node.dataset.entry === anchorId,
  );
  transcript.scrollTop = bottom
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
      `#${session.created_seq} · ${session.harness} · ${phase} · ${session.id} · ${session.cwd}`,
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
  status.textContent = `${state.view?.status || 'Select or create a session'}${snapshot ? ` · ${typeof snapshot.status === 'string' ? snapshot.status : 'Failed'} · revision ${snapshot.revision}` : ''}${!state.trusted ? ' · workspace untrusted' : ''}`;
  const busy =
    !snapshot || !state.trusted || state.view?.status !== 'ready' || snapshot.active_turn !== null;
  submit.disabled = busy || pendingPrompts.has(snapshot?.id || '');
  submit.textContent = pendingPrompts.has(snapshot?.id || '') ? 'Confirming acceptance…' : 'Send';
  prompt.disabled = !snapshot;
  attach.disabled = !snapshot || !state.trusted;
  cancel.disabled = !snapshot || !state.trusted || snapshot.active_turn === null;
  if (snapshot) {
    renderSettings(snapshot, busy);
    renderTranscript(snapshot, busy);
    renderInteractions(snapshot);
  } else {
    settings.replaceChildren();
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
    if (raw.type === 'state') {
      const message = uiStateMessage.parse(raw);
      if (message.sequence <= sequence) return;
      sequence = message.sequence;
      state = message.state;
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
      raw.type === 'prompt_accepted' &&
      'session' in raw &&
      typeof raw.session === 'string' &&
      'text' in raw &&
      typeof raw.text === 'string'
    ) {
      pendingPrompts.delete(raw.session);
      const text = raw.session === selected ? prompt.value : drafts.get(raw.session);
      try {
        if (raw.text === composePrompt(text, attachmentDrafts.get(raw.session))) {
          attachmentDrafts.set(raw.session, []);
          drafts.set(raw.session, '');
          if (raw.session === selected) {
            prompt.value = '';
            renderAttachments();
          }
          persist();
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
        attachmentDrafts.set(selected || '', [
          ...attachmentDrafts.get(selected || ''),
          ...raw.files,
        ]);
        persist();
        renderAttachments();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Invalid attachments';
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
  for (const image of images.values()) URL.revokeObjectURL(image.url);
  images.clear();
  contentPages.clear();
  pendingImages.clear();
});
send({ type: 'ready' });
