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
async function browser() {
  dom = new JSDOM('<main id="workbench"></main>', { pretendToBeVisual: true });
  const sent: UiCommand[] = [];
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (message: UiCommand) => sent.push(message),
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
    state,
    post,
    document: dom.window.document,
    update(sequence = 1) {
      post({ type: 'state', sequence, state: this.state });
    },
  };
}
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
