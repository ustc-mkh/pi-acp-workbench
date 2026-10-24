import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { emptyView } from './helpers/workbench-peer';
import { entryId, imageRef, operationId } from '../src/workbench-protocol';
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
    accept(session: string, prompt: unknown, piAfter?: number) {
      const request = [...sent]
        .reverse()
        .find((m) => m.type === 'execute' && m.command.method === 'prompt');
      const generation = request?.type === 'execute' ? request.generation : 0;
      post({ type: 'prompt_submitted', session, generation, operation: 'prompt-operation' });
      post({
        type: 'prompt_accepted',
        session,
        prompt,
        generation,
        operation: 'prompt-operation',
        pi_after_seq: piAfter,
      });
    },
    update(sequence = 1) {
      post({ type: 'state', sequence, state: this.state });
    },
  };
}
it('disables session creation until initial authorized workspace state arrives and again after trust revocation', async () => {
  const b = await browser();
  const create = [...b.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'New session',
  )!;
  expect(create.disabled).toBe(true);
  create.click();
  expect(b.sent).toEqual([{ type: 'ready' }]);
  b.update();
  await expect.poll(() => create.disabled).toBe(false);
  create.click();
  expect(b.sent.at(-1)).toMatchObject({
    type: 'create',
    command: { method: 'create', harness: 'Pi', cwd: '/workspace' },
  });
  b.state.trusted = false;
  b.update(2);
  await expect.poll(() => create.disabled).toBe(true);
  const count = b.sent.length;
  create.click();
  expect(b.sent).toHaveLength(count);
});
it('searches whole history and resumes only the latest frozen clear preview without auto-deleting', async () => {
  const b = await browser();
  b.update();
  const search = b.document.querySelector<HTMLInputElement>('[aria-label="Search all sessions"]')!;
  search.value = ' old session ';
  b.document.querySelector<HTMLSelectElement>('[aria-label="History harness filter"]')!.value =
    'Pi';
  search.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(b.sent.at(-1)).toEqual({
    type: 'refresh',
    filter: { text: 'old session', harness: 'Pi' },
  });
  const report = {
    job: operationId.parse('clear-job'),
    total: 12,
    remaining: 12,
    failed: 0,
    active: 2,
    pending_deliveries: 3,
    preview: true,
  };
  b.state.operations = [
    {
      operation: operationId.parse('preview'),
      method: 'prepare_history_clear',
      status: 'completed',
      historyClear: report,
    },
    {
      operation: operationId.parse('batch'),
      method: 'clear_history_batch',
      status: 'completed',
      historyClear: { ...report, remaining: 2, preview: false },
    },
  ];
  const before = b.sent.length;
  b.update(2);
  await expect.poll(() => b.document.body.textContent).toContain('2 pending');
  expect(b.document.body.textContent).toContain('3 pending deliveries');
  expect(b.sent).toHaveLength(before);
  const next = [...b.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Confirm next clear batch…',
  )!;
  expect(next).toBeDefined();
  expect(b.document.body.textContent).not.toContain('Confirm first clear batch');
  next.click();
  expect(b.sent.at(-1)).toEqual({ type: 'clear_history_batch', job: 'clear-job' });
});
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
  b.accept('other', { parts: [{ type: 'text', text: 'hello' }] });
  expect(prompt.value).toBe('hello');
  b.accept('session', { parts: [{ type: 'text', text: 'hello' }] });
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

it('preserves Pi drafts when an autonomous wake rejects an already accepted input', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  prompt.value = 'keep this input';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  b.accept('session', { parts: [{ type: 'text', text: 'keep this input' }] }, 0);
  expect(prompt.value).toBe('keep this input');
  b.state.view!.view!.active_turn = 'autonomous-turn' as never;
  b.state.view!.view!.status = 'Running';
  b.state.view!.view!.revision++;
  b.state.view = {
    ...b.state.view!,
    entries: [
      {
        seq: 1,
        id: entryId.parse('input'),
        turn: 'user-turn' as never,
        role: 'User',
        text: { Inline: { text: 'keep this input' } },
        message: null,
        image: null,
      },
      {
        seq: 2,
        id: entryId.parse('rejection'),
        turn: 'user-turn' as never,
        role: 'Agent',
        text: { Inline: { text: 'input rejected' } },
        message: 'pi-workbench-input-rejected' as never,
        image: null,
      },
    ],
  };
  b.update(2);
  await expect.poll(() => b.document.body.textContent).toContain('draft preserved');
  expect(prompt.value).toBe('keep this input');
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
    command: { method: 'prompt', prompt: { parts: [{ type: 'text', text: '你好' }] } },
  });
  expect(prompt.value).toBe('你好');
  expect(b.saved()).toMatchObject({ drafts: [['session', '你好']] });
  b.accept('session', { parts: [{ type: 'text', text: '你好' }] });
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
      prompt: {
        parts: [
          { type: 'text', text: 'Review' },
          { type: 'context', id: 'f', name: 'src/a.ts', text: '<script>safe text</script>' },
        ],
      },
    },
  });
  b.accept('session', { parts: [{ type: 'text', text: 'Review' }] });
  expect(prompt.value).toBe('Review');
  expect(b.document.querySelector('#attachments pre')).not.toBeNull();
  if (sent?.type !== 'execute' || sent.command.method !== 'prompt')
    throw new Error('missing prompt');
  b.accept('session', sent.command.prompt);
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

it('does not clear an edited-back draft on late acceptance and requires the original operation', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  prompt.value = 'same';
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  const request = b.sent.at(-1);
  if (request?.type !== 'execute' || request.command.method !== 'prompt')
    throw new Error('missing typed prompt');
  b.post({
    type: 'prompt_submitted',
    session: 'session',
    operation: 'original',
    generation: request.generation,
  });
  prompt.value = 'changed';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  prompt.value = 'same';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  b.post({
    type: 'prompt_accepted',
    session: 'session',
    operation: 'wrong',
    generation: request.generation,
    prompt: request.command.prompt,
  });
  expect(prompt.value).toBe('same');
  b.post({
    type: 'prompt_accepted',
    session: 'session',
    operation: 'original',
    generation: request.generation,
    prompt: request.command.prompt,
  });
  expect(prompt.value).toBe('same');
  expect(b.saved()).toMatchObject({ drafts: [['session', 'same']] });
});

it('groups identified Markdown fragments and preserves message, turn, focus and text selection across deltas', async () => {
  const b = await browser();
  const rows = [
    'Hello **',
    'world**\n\n```ts\n',
    'const x = 1;\n```\n\n[site](https://example.com)',
  ].map((text, i) => ({
    seq: i + 1,
    id: entryId.parse(`group-${i}`),
    turn: 'turn' as never,
    role: 'Agent' as const,
    text: { Inline: { text } },
    message: 'provider-message' as never,
    image: null,
  }));
  b.state.view = { ...b.state.view!, entries: rows };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('article').length).toBe(1);
  const article = b.document.querySelector('article')!,
    turn = b.document.querySelector('[data-turn]')!;
  expect(article.querySelector('strong')?.textContent).toBe('world');
  expect(article.querySelector('code')?.textContent).toContain('const x = 1;');
  const copy = [...article.querySelectorAll('button')].find(
    (button) => button.textContent === 'Copy message',
  )!;
  copy.focus();
  const range = b.document.createRange();
  range.selectNodeContents(article.querySelector('strong')!);
  dom!.window.getSelection()!.removeAllRanges();
  dom!.window.getSelection()!.addRange(range);
  expect(dom!.window.getSelection()!.toString()).toBe('world');
  b.state.view!.view!.revision++;
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(b.document.querySelector('article')).toBe(article);
  expect(b.document.querySelector('[data-turn]')).toBe(turn);
  expect(b.document.activeElement).toBe(copy);
  expect(dom!.window.getSelection()!.toString()).toBe('world');
  article.querySelector('a')!.click();
  expect(b.sent.at(-1)).toEqual({ type: 'open_link', url: 'https://example.com' });
  expect(b.state.view!.entries).toEqual(rows);
});

it('completes only declared slash commands with keyboard/IME and restores accessible resize', async () => {
  const b = await browser({ preferences: { composerHeight: 140, sessionRows: 16 } });
  b.state.view!.view!.catalogue.commands = [
    { name: 'review', description: 'Review changes', input_hint: 'target' },
    { name: 'reset', description: 'Reset', input_hint: null },
  ];
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLTextAreaElement>('#prompt')!.disabled)
    .toBe(false);
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  prompt.value = '/re';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  expect(b.document.querySelectorAll('#commands button')).toHaveLength(2);
  prompt.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
  );
  expect(prompt.value).toBe('/re');
  prompt.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  );
  prompt.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  expect(prompt.value).toBe('/reset ');
  expect(b.sent.filter((message) => message.type === 'execute')).toHaveLength(0);
  const resize = b.document.querySelector('.composer-resize')!;
  resize.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
  );
  expect(prompt.style.height).toBe('156px');
  expect(b.saved()).toMatchObject({ preferences: { composerHeight: 156, sessionRows: 16 } });
  b.state.view!.view!.catalogue.commands = [];
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  prompt.value = '/';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  expect(b.document.querySelectorAll('#commands button')).toHaveLength(0);
});

it('renders actual separate Thinking/Fast selects and preserves their DOM across unrelated deltas', async () => {
  const b = await browser();
  b.state.view!.view!.catalogue.selects = [
    {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      current_value: 'low',
      choices: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'fast',
      name: 'Fast',
      category: 'other',
      current_value: 'off',
      choices: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  ];
  b.update();
  await expect.poll(() => b.document.querySelector('select[aria-label="Thinking"]')).not.toBeNull();
  const thinking = b.document.querySelector<HTMLSelectElement>('select[aria-label="Thinking"]')!;
  thinking.focus();
  thinking.value = 'high';
  b.state.view!.view!.revision++;
  b.state.view!.view!.usage.output_tokens++;
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(b.document.querySelector('select[aria-label="Thinking"]')).toBe(thinking);
  expect(b.document.activeElement).toBe(thinking);
  expect(thinking.value).toBe('high');
  thinking.dispatchEvent(new dom!.window.Event('change'));
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'set_option', id: 'thought_level', value: 'high' },
  });
  const fast = b.document.querySelector<HTMLSelectElement>('select[aria-label="Fast"]')!;
  fast.value = 'on';
  fast.dispatchEvent(new dom!.window.Event('change'));
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'set_option', id: 'fast', value: 'on' },
  });
});
