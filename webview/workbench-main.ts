import { createRenderer } from './markdown';
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

declare function acquireVsCodeApi(): { postMessage(message: UiCommand): void };
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
const drafts = new Map<string, string>();
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
  transcript = element('section');
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
composer.append(prompt, submit, cancel);
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const snapshot = current();
  if (!snapshot || !prompt.value.trim() || submit.disabled) return;
  mutate({ method: 'prompt', session: snapshot.id, prompt: prompt.value });
});
root.append(
  header,
  sessions,
  status,
  error,
  settings,
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
  transcript.replaceChildren();
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
    const article = element('article');
    article.dataset.entry = row.id;
    article.className = row.role.toLowerCase();
    article.append(element('small', `${row.role} · ${row.seq}`));
    const content = element('div');
    if ('Inline' in row.text) {
      content.innerHTML = markdown(row.text.Inline.text);
      content
        .querySelectorAll('a')
        .forEach((link) => link.addEventListener('click', (event) => event.preventDefault()));
    } else content.append(contentNode(row.text.Archived.content, snapshot.id));
    if (row.role === 'Thought') {
      const details = element('details');
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
    transcript.append(article);
  }
  const visibleTurns = new Set(rows.map((row) => row.turn));
  for (const turn of visibleTurns)
    transcript.append(
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
    const details = element('details');
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
    transcript.append(details);
  }
  if (snapshot.plan.items.length) {
    const plan = element('details');
    plan.append(element('summary', 'Plan'));
    for (const item of snapshot.plan.items)
      plan.append(element('p', `${item.status}: ${item.description}`));
    transcript.append(plan);
  }
  transcript.scrollTop = bottom ? transcript.scrollHeight : scroll;
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
    drafts.set(selected || '', prompt.value);
    if (drafts.size > 16) drafts.delete(drafts.keys().next().value!);
    selected = state.selected;
    prompt.value = drafts.get(selected || '') || '';
    for (const image of images.values()) URL.revokeObjectURL(image.url);
    images.clear();
    contentPages.clear();
    imageBytes = 0;
    imageErrors.clear();
    pendingImages.clear();
    interactions.replaceChildren();
  }
  sessions.replaceChildren(element('option', 'Select session'));
  for (const session of state.sessions) {
    const option = element('option', `${session.harness} · ${session.id} · ${session.cwd}`);
    option.value = session.id;
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
  submit.disabled = busy;
  prompt.disabled = !snapshot;
  cancel.disabled = !snapshot || !state.trusted || snapshot.active_turn === null;
  if (snapshot) {
    renderSettings(snapshot, busy);
    renderTranscript(snapshot, busy);
    renderInteractions(snapshot);
  } else {
    settings.replaceChildren();
    transcript.replaceChildren();
    interactions.replaceChildren();
  }
  operations.replaceChildren();
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
      schedule();
    } else if (
      raw.type === 'prompt_accepted' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'text' in raw &&
      raw.text === prompt.value
    ) {
      prompt.value = '';
    } else if (
      raw.type === 'draft' &&
      'text' in raw &&
      typeof raw.text === 'string' &&
      raw.text.length <= 200000
    ) {
      const next = prompt.value + `${prompt.value ? '\n\n' : ''}${raw.text}`;
      if (next.length <= prompt.maxLength) prompt.value = next;
      else error.textContent = 'Draft is too large; selection was not appended';
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
