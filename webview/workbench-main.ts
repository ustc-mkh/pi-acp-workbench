import { createRenderer } from './markdown';
import {
  ipcMessage,
  type ClientCommand,
  type ImageAsset,
  type ImageRef,
  type SessionSnapshot,
} from '../src/workbench-protocol';
import { uiStateMessage, type UiCommand, type WorkbenchUiState } from '../src/workbench-ui';

declare function acquireVsCodeApi(): { postMessage(message: UiCommand): void };
const vscode = acquireVsCodeApi(),
  root = document.querySelector<HTMLElement>('#workbench')!;
const markdown = createRenderer(window);
let state: WorkbenchUiState | undefined,
  sequence = 0,
  selected: string | undefined,
  visible = 100;
const images = new Map<string, { asset: ImageAsset; url: string }>();
const imageErrors = new Map<string, string>(),
  pendingImages = new Set<string>();
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
  return state?.view?.snapshot;
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
function renderSettings(snapshot: SessionSnapshot, busy: boolean) {
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
              model: value.id as NonNullable<SessionSnapshot['config']['model']>,
            }
          : {
              method: 'set_mode',
              session: snapshot.id,
              mode: value.id as NonNullable<SessionSnapshot['config']['mode']>,
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
function imageNode(ref: ImageRef, session: SessionSnapshot['id']) {
  const box = element('figure'),
    cached = images.get(ref.id);
  if (cached) {
    const img = element('img');
    img.alt = 'Archived agent image';
    img.src = cached.url;
    box.append(img);
  } else {
    const load = button(
      pendingImages.has(ref.id) ? 'Loading image…' : 'Load archived image',
      () => {
        if (pendingImages.size >= 4) return;
        pendingImages.add(ref.id);
        send({ type: 'read_image', session, image: ref });
        schedule();
      },
      pendingImages.has(ref.id) || pendingImages.size >= 4,
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
function renderTranscript(snapshot: SessionSnapshot, busy: boolean) {
  const rows = [...snapshot.transcript.entries, ...(state?.view?.provisional || [])];
  const scroll = transcript.scrollTop,
    bottom = transcript.scrollHeight - transcript.clientHeight - scroll < 80;
  transcript.replaceChildren();
  if (rows.length > visible)
    transcript.append(
      button(`Show earlier (${rows.length - visible})`, () => {
        visible += 100;
        schedule();
      }),
    );
  const committed = new Set(snapshot.transcript.entries.map((row) => row.id));
  for (const row of rows.slice(-visible)) {
    const article = element('article');
    article.dataset.entry = row.id;
    article.className = row.role.toLowerCase();
    article.append(
      element('small', `${row.role}${committed.has(row.id) ? '' : ' · synchronizing'}`),
    );
    const content = element('div');
    content.innerHTML = markdown(row.text);
    // Markdown links and image markers are display metadata, never automatic I/O.
    content
      .querySelectorAll('a')
      .forEach((link) => link.addEventListener('click', (event) => event.preventDefault()));
    if (row.role === 'Thought') {
      const details = element('details'),
        summary = element('summary', 'Thought');
      details.append(summary, content);
      article.append(details);
    } else article.append(content);
    if (row.image) article.append(imageNode(row.image, snapshot.id));
    if (committed.has(row.id) && ['Agent', 'User'].includes(row.role) && !row.image)
      article.append(
        button(
          'Fork here',
          () => {
            mutate({ method: 'fork', session: snapshot.id, request: { entry: row.id } });
          },
          busy || snapshot.status !== 'Idle',
        ),
      );
    transcript.append(article);
  }
  const visibleTurns = new Set<string>(rows.slice(-visible).map((row) => row.turn));
  let toolCount = 0;
  for (const [turn, tools] of Object.entries(snapshot.transcript.tools))
    for (const tool of Object.values(tools)) {
      if (!visibleTurns.has(turn) || toolCount++ >= 300) continue;
      const details = element('details'),
        summary = element('summary', `${tool.title} · ${tool.status}`);
      details.append(summary);
      for (const content of tool.details.content) {
        if ('Text' in content) details.append(element('pre', content.Text.text));
        else if ('Diff' in content)
          details.append(
            element(
              'pre',
              `${content.Diff.path}\n---\n${content.Diff.old_text ?? ''}\n+++\n${content.Diff.new_text}`,
            ),
          );
        else if ('ResourceText' in content)
          details.append(
            element('pre', `${content.ResourceText.uri}\n${content.ResourceText.text}`),
          );
        else if ('ResourceLink' in content)
          details.append(element('p', `${content.ResourceLink.name}: ${content.ResourceLink.uri}`));
        else if ('TerminalReference' in content)
          details.append(
            element('p', `Terminal reference: ${content.TerminalReference.id} (display only)`),
          );
        else details.append(element('p', `Unsupported binary: ${content.Unsupported.kind}`));
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
function renderInteractions(snapshot: SessionSnapshot) {
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
    visible = 100;
    images.clear();
    imageBytes = 0;
    imageErrors.clear();
    pendingImages.clear();
    interactions.replaceChildren();
  }
  sessions.replaceChildren(element('option', 'Select session'));
  for (const session of state.sessions) {
    const option = element(
      'option',
      `${session.harness} · ${session.transcript.entries.find((row) => row.role === 'User')?.text.slice(0, 50) || session.id} · ${session.cwd}`,
    );
    option.value = session.id;
    sessions.append(option);
  }
  sessions.value = state.selected || '';
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
      const message = ipcMessage.parse({ type: 'image', id: 0, asset: raw.asset });
      if (message.type !== 'image') return;
      const asset = message.asset,
        ref = [...(current()?.transcript.entries || []), ...(state?.view?.provisional || [])].find(
          (row) => row.image?.id === asset.image.id,
        )?.image;
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
        while (imageBytes + ref.bytes > 16 * 1024 * 1024 && images.size) {
          const first = images.keys().next().value!;
          imageBytes -= images.get(first)!.asset.image.bytes;
          images.delete(first);
        }
        images.set(ref.id, { asset, url: `data:${ref.mime};base64,${asset.data}` });
        imageBytes += ref.bytes;
      }
      pendingImages.delete(ref.id);
      imageErrors.delete(ref.id);
      schedule();
    } else if (
      raw.type === 'image_error' &&
      'session' in raw &&
      raw.session === state?.selected &&
      'image' in raw &&
      typeof raw.image === 'string'
    ) {
      pendingImages.delete(raw.image);
      imageErrors.set(raw.image, 'Archive unavailable');
      schedule();
    }
  } catch {
    error.textContent = 'Invalid workbench view message; refresh or reconnect';
  }
});
send({ type: 'ready' });
