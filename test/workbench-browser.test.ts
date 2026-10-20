import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { emptyView } from './helpers/workbench-peer';
import { entryId, imageRef } from '../src/workbench-protocol';
import type { UiCommand, WorkbenchUiState } from '../src/workbench-ui';
let dom: JSDOM | undefined;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function browser(saved?: unknown) {
  dom = new JSDOM('<main id="workbench"></main>', { pretendToBeVisual: true });
  const sent: UiCommand[] = [];
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  let persisted = saved;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (message: UiCommand) => sent.push(message),
    getState: () => persisted,
    setState: (value: unknown) => {
      persisted = value;
    },
  }));
  await import('../webview/workbench-main');
  const snapshot = emptyView();
  const state: WorkbenchUiState = {
    sessions: [
      {
        id: snapshot.id,
        harness: snapshot.harness,
        cwd: snapshot.cwd,
        status: snapshot.status,
        revision: snapshot.revision,
        created_seq: 1,
      },
    ],
    selected: snapshot.id,
    view: { status: 'ready', view: snapshot, entries: [], tools: [], historical: false },
    operations: [],
    trusted: true,
    workspace: '/workspace',
  };
  const post = (value: unknown) =>
    dom!.window.dispatchEvent(new dom!.window.MessageEvent('message', { data: value }));
  return {
    sent,
    saved: () => persisted,
    state,
    post,
    document: dom.window.document,
    update(sequence = 1) {
      post({ type: 'state', sequence, state: this.state });
    },
  };
}
it('keeps a restored selection visible outside the current session page without triggering a mutation', async () => {
  const b = await browser();
  b.state.sessions = [];
  b.update();
  const select = b.document.querySelector<HTMLSelectElement>('select[aria-label="Session"]')!;
  await expect.poll(() => select.value).toBe('session');
  expect(select.selectedOptions[0].textContent).toContain('outside this page');
  expect(b.sent).toEqual([{ type: 'ready' }]);
  b.state.sessions = [
    {
      id: b.state.view!.view!.id,
      harness: 'Pi',
      cwd: '/workspace',
      status: 'Idle',
      revision: 1,
      created_seq: 42,
    },
  ];
  b.update(2);
  await expect.poll(() => select.selectedOptions[0].textContent).toContain('#42');
  expect(select.options).toHaveLength(2);
});

it('bounds review caches and ignores duplicate diff pages across session changes', async () => {
  const b = await browser();
  b.state.view = {
    ...b.state.view!,
    entries: Array.from({ length: 18 }, (_, i) => ({
      seq: i + 1,
      id: entryId.parse(`entry-${i}`),
      turn: `turn-${i}` as never,
      role: 'User',
      text: { Inline: { text: 'review' } },
      message: null,
      image: null,
    })),
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('article').length).toBe(18);
  const diff = {
    status: 'complete',
    files: [],
    warnings: [],
    added: 0,
    removed: 0,
    next_offset: null,
  };
  for (let i = 0; i < 18; i++)
    b.post({ type: 'turn_diff', session: 'session', turn: `turn-${i}`, diff });
  await expect
    .poll(() => b.document.body.textContent?.match(/No captured workspace changes/g)?.length)
    .toBe(16);
  const file = {
    path: 'only-once.txt',
    status: 'added',
    before: null,
    after: 'saved',
    old_mode: null,
    new_mode: 33188,
    added: 1,
    removed: 0,
    omitted: null,
  };
  b.post({
    type: 'turn_diff',
    session: 'session',
    turn: 'turn-17',
    diff: { ...diff, next_offset: 1, files: [file] },
  });
  const page = {
    type: 'turn_diff',
    session: 'session',
    turn: 'turn-17',
    offset: 1,
    diff: { ...diff, files: [{ ...file, path: 'second.txt' }] },
  };
  b.post(page);
  b.post(page);
  await expect
    .poll(() => [...b.document.querySelectorAll('h3')].map((n) => n.textContent))
    .toEqual(['added · only-once.txt', 'added · second.txt']);
  b.state.selected = 'other' as never;
  b.state.view!.view!.id = 'other' as never;
  b.update(2);
  await expect.poll(() => b.document.querySelectorAll('h3').length).toBe(0);
});

it('offers full Markdown export as a distinct user action for the selected session', async () => {
  const b = await browser();
  b.update();
  const exportButton = [...b.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Export Markdown',
  )!;
  expect(exportButton).toBeDefined();
  exportButton.click();
  expect(b.sent.at(-1)).toEqual({ type: 'export', session: b.state.selected });
  expect(b.sent.some((message) => message.type === 'execute')).toBe(false);
});

it('renders committed rows without merging group deltas, never fetching markdown/tool URIs', async () => {
  const b = await browser(),
    snapshot = b.state.view!.view!;
  expect(b.sent).toEqual([{ type: 'ready' }]);
  b.state.view = {
    ...b.state.view!,
    entries: [
      'hello ',
      '世界\n\n![evil](https://example.invalid/image.png) <script>window.pwned=true</script>',
    ].map((text, i) => ({
      seq: i + 1,
      id: entryId.parse(`e-${i}`),
      turn: 'turn' as never,
      role: 'Agent',
      text: { Inline: { text } },
      message: null,
      image: null,
    })),
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('article').length).toBe(2);
  expect(b.document.querySelector('img')).toBeNull();
  expect(b.document.querySelector('script')).toBeNull();
  expect(b.document.body.textContent).toContain('世界');
  const fork = [...b.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Fork here',
  )!;
  fork.click();
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'fork', request: { entry: 'e-0' } },
  });
  b.post({ type: 'state', sequence: 0, state: { ...b.state, selected: 'obsolete' } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(b.document.querySelectorAll('article')).toHaveLength(2);
});
it('only explicit matching archive image responses become data URLs; source URIs never authorize reads', async () => {
  const b = await browser(),
    snapshot = b.state.view!.view!;
  const bytes = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(bytes);
  bytes.write('IHDR', 12);
  const ref = imageRef.parse({
    id: 'image',
    mime: 'image/png',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  b.state.view = {
    ...b.state.view!,
    entries: [
      {
        seq: 1,
        id: entryId.parse('entry'),
        turn: 'turn' as never,
        role: 'Agent',
        text: { Inline: { text: '' } },
        image: ref,
        message: null,
      },
    ],
  };
  b.update();
  await expect.poll(() => b.document.querySelector('figure')).not.toBeNull();
  expect(b.document.querySelector('img')).toBeNull();
  expect(b.sent).toHaveLength(1);
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === 'Load archived image')!
    .click();
  expect(b.sent.at(-1)).toEqual({
    type: 'read_image',
    session: snapshot.id,
    image: ref,
    request_id: 1,
  });
  const asset = { format_version: 1, image: ref, data: bytes.toString('base64') };
  b.post({ type: 'image', session: 'other', asset });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(b.document.querySelector('img')).toBeNull();
  b.post({ type: 'image', session: snapshot.id, asset });
  await expect.poll(() => b.document.querySelector('img')?.src).toMatch(/^blob:/);
});
it('preserves typed form drafts while refreshing snapshots and submits permission/form answers by exact ID', async () => {
  const b = await browser(),
    snapshot = b.state.view!.view!;
  snapshot.pending_interactions = {
    permission: {
      id: 'permission' as never,
      kind: 'Permission',
      title: 'Allow?',
      detail: '<script>bad</script>',
      options: [{ id: 'allow-once', label: 'Allow once' }],
      fields: [],
      expires_at: null,
    },
    form: {
      id: 'form' as never,
      kind: 'Elicitation',
      title: 'Questions',
      detail: 'Typed fields',
      options: [],
      expires_at: null,
      fields: [
        { name: 'text', label: 'Text', required: true, kind: { Text: { max_length: 100 } } },
        { name: 'count', label: 'Count', required: true, kind: { Integer: { min: 1, max: 10 } } },
        { name: 'bool', label: 'Flag', required: true, kind: 'Boolean' },
        {
          name: '__proto__',
          label: 'Opaque key',
          required: true,
          kind: { Text: { max_length: 100 } },
        },
      ],
    },
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('#interactions form').length).toBe(2);
  const form = b.document.querySelector<HTMLFormElement>('[data-interaction="form"]')!;
  form.querySelector('textarea')!.value = 'answer';
  form.querySelectorAll('textarea')[1].value = 'opaque key';
  form.querySelector<HTMLInputElement>('input[type=number]')!.value = '4';
  form.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true;
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(b.document.querySelector('[data-interaction="form"]')).toBe(form);
  form.dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: {
      method: 'answer',
      answer: {
        interaction: 'form',
        response: {
          Form: {
            fields: {
              text: { Text: 'answer' },
              count: { Integer: 4 },
              bool: { Boolean: true },
              ['__proto__']: { Text: 'opaque key' },
            },
          },
        },
      },
    },
  });
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === 'Allow once')!
    .click();
  expect(b.sent.at(-1)).toMatchObject({
    command: {
      method: 'answer',
      answer: { interaction: 'permission', response: { Permission: { option: 'allow-once' } } },
    },
  });
});
it('allows explicit recovery from Failed without enabling native forks and isolates draft text by session', async () => {
  const b = await browser();
  b.state.view!.view!.status = { Failed: 'worker exited' };
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLTextAreaElement>('#prompt')?.disabled)
    .toBe(false);
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  prompt.value = 'source draft';
  expect(
    [...b.document.querySelectorAll('button')].find((button) => button.textContent === 'Send')!
      .disabled,
  ).toBe(false);
  expect(b.document.querySelector('[role=alert]')!.textContent).toBe('worker exited');
  const original = b.state.view!.view!;
  const other = { ...emptyView(), id: 'other' as never };
  b.state = {
    ...b.state,
    selected: other.id,
    view: { status: 'ready', view: other, entries: [], tools: [], historical: false },
  };
  b.update(2);
  await expect.poll(() => prompt.value).toBe('');
  prompt.value = 'other draft';
  b.state = {
    ...b.state,
    selected: original.id,
    view: { status: 'ready', view: original, entries: [], tools: [], historical: false },
  };
  b.update(3);
  await expect.poll(() => prompt.value).toBe('source draft');
});

it('keeps failed prompt drafts and clears only the matching accepted draft; fork cancellation carries the original operation', async () => {
  const b = await browser();
  b.state.operations.push({
    operation: 'original-fork' as never,
    method: 'fork',
    session: 'session',
    status: 'pending',
  });
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLTextAreaElement>('#prompt')?.disabled)
    .toBe(false);
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  prompt.value = 'hello';
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  expect(prompt.value).toBe('hello');
  b.post({ type: 'prompt_accepted', session: 'other', text: 'hello' });
  expect(prompt.value).toBe('hello');
  b.post({ type: 'prompt_accepted', session: 'session', text: 'hello' });
  expect(prompt.value).toBe('');
  await expect
    .poll(() =>
      [...b.document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Cancel this fork',
      ),
    )
    .toBe(true);
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === 'Cancel this fork')!
    .click();
  expect(b.sent.at(-1)).toEqual({ type: 'cancel_fork', operation: 'original-fork' });
});

it('sends on Enter but not Shift+Enter or IME, retaining the draft until accepted', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  prompt.value = '你好';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }])
    prompt.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ...options }));
  expect(b.sent).toEqual([{ type: 'ready' }]);
  prompt.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
  );
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'prompt', prompt: '你好' },
  });
  expect(prompt.value).toBe('你好');
  expect(b.saved()).toMatchObject({ drafts: [['session', '你好']] });
  b.post({ type: 'prompt_accepted', session: 'session', text: '你好' });
  expect(b.saved()).toMatchObject({ drafts: [] });
});

it('restores reload text without replaying a mutation', async () => {
  const b = await browser({ drafts: [['session', 'not yet accepted']] });
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.value).toBe('not yet accepted');
  expect(b.sent).toEqual([{ type: 'ready' }]);
});

it('previews explicit attachments, isolates sessions and clears only a matching accepted input', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  [...b.document.querySelectorAll('button')]
    .find((row) => row.textContent === 'Attach files')!
    .click();
  expect(b.sent.at(-1)).toEqual({ type: 'attach_files', session: 'session' });
  b.post({
    type: 'attachments',
    session: 'other',
    files: [{ id: 'bad', name: 'bad', text: 'secret' }],
  });
  expect(b.document.querySelector('#attachments')!.textContent).not.toContain('secret');
  b.post({
    type: 'attachments',
    session: 'session',
    files: [{ id: 'f', name: 'src/a.ts', text: '<script>safe text</script>' }],
  });
  expect(b.document.querySelector('#attachments pre')!.textContent).toBe(
    '<script>safe text</script>',
  );
  expect(b.document.querySelector('#attachments script')).toBeNull();
  prompt.value = 'Review';
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  const sent = b.sent.at(-1);
  expect(sent).toMatchObject({
    type: 'execute',
    command: {
      method: 'prompt',
      prompt: 'Review\n\nExplicit file attachment: src/a.ts\n\n<script>safe text</script>',
    },
  });
  b.post({ type: 'prompt_accepted', session: 'session', text: 'Review' });
  expect(prompt.value).toBe('Review');
  expect(b.document.querySelector('#attachments pre')).not.toBeNull();
  if (sent?.type !== 'execute' || sent.command.method !== 'prompt')
    throw new Error('missing prompt');
  b.post({ type: 'prompt_accepted', session: 'session', text: sent.command.prompt });
  expect(prompt.value).toBe('');
  expect(b.document.querySelector('#attachments pre')).toBeNull();
  expect(b.saved()).toMatchObject({ attachments: [], drafts: [] });
});

it('restores attachments and thought preferences on reload without replaying any command', async () => {
  const b = await browser({
    drafts: [['session', 'Review']],
    attachments: [['session', [{ id: 'f', name: 'a.ts', text: 'saved context' }]]],
    preferences: { showThoughts: false, disclosures: [] },
  });
  b.update();
  await expect
    .poll(() => b.document.querySelector('#attachments pre')?.textContent)
    .toBe('saved context');
  expect(b.document.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe('Review');
  expect(b.document.querySelector<HTMLInputElement>('label input[type=checkbox]')!.checked).toBe(
    false,
  );
  expect(b.sent).toEqual([{ type: 'ready' }]);
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === 'Remove attachment a.ts')!
    .click();
  expect(b.saved()).toMatchObject({ attachments: [] });
});

it('retains plan DOM, turn expansion and thought preferences across streamed state refreshes', async () => {
  const b = await browser();
  const snapshot = b.state.view!.view!;
  snapshot.plan = {
    items: [{ description: 'Implement feature', status: 'InProgress' }],
  } as typeof snapshot.plan;
  b.state.view = {
    ...b.state.view!,
    entries: ['Thought', 'Agent'].map((role, i) => ({
      seq: i + 1,
      id: entryId.parse(`group-${i}`),
      turn: 'turn' as never,
      role: role as 'Thought' | 'Agent',
      text: { Inline: { text: role } },
      message: null,
      image: null,
    })),
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('[data-turn]').length).toBe(1);
  const agentArticle = b.document.querySelector('article.agent');
  const plan = b.document.querySelector('#plan details')!;
  expect(b.document.querySelector('#transcript #plan')).toBeNull();
  const process = b.document.querySelector<HTMLDetailsElement>('.turn-process')!;
  process.open = true;
  process.dispatchEvent(new dom!.window.Event('toggle'));
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(b.document.querySelector('#plan details')).toBe(plan);
  expect(b.document.querySelector('article.agent')).toBe(agentArticle);
  expect(b.document.querySelector<HTMLDetailsElement>('.turn-process')!.open).toBe(true);
  const checkbox = b.document.querySelector<HTMLInputElement>('label input[type=checkbox]')!;
  checkbox.checked = false;
  checkbox.dispatchEvent(new dom!.window.Event('change'));
  await expect.poll(() => b.document.querySelectorAll('article.thought').length).toBe(0);
  expect(b.document.querySelectorAll('article.agent')).toHaveLength(1);
  expect(b.saved()).toMatchObject({ preferences: { showThoughts: false } });
});
