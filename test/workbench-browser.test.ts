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
async function browser(saved?: unknown, silentIntersectionObserver = false) {
  dom = new JSDOM('<main id="workbench"></main>', { pretendToBeVisual: true });
  if (silentIntersectionObserver)
    Object.defineProperty(dom.window, 'IntersectionObserver', {
      value: class {
        observe() {}
        disconnect() {}
      },
    });
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
    (button) => button.getAttribute('aria-label') === '新对话',
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
  const search = b.document.querySelector<HTMLInputElement>('[aria-label="搜索全部会话"]')!;
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
    (button) => button.textContent === '确认清空下一批…',
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
  const selected = () =>
    b.document.querySelector<HTMLElement>('#history-items [aria-selected="true"]')!;
  await expect.poll(() => selected()?.dataset.sessionId).toBe('session');
  expect(selected().textContent).toContain('不在此列表页');
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
  await expect.poll(() => selected()?.textContent).toContain('#042');
  expect(b.document.querySelectorAll('#history-items [role=option]')).toHaveLength(1);
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
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(b.document.querySelectorAll('[data-turn-review]')).toHaveLength(16); // Includes explicit zero-change results within the cache budget.
  expect(b.sent.filter((m) => m.type === 'read_turn_diff').length).toBeLessThanOrEqual(4);
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
    .poll(() =>
      [...b.document.querySelectorAll('.turn-diff-file > summary')].map((n) => n.textContent),
    )
    .toEqual(['新增 · only-once.txt  +1 −0', '新增 · second.txt  +1 −0']);
  b.state.selected = 'other' as never;
  b.state.view!.view!.id = 'other' as never;
  b.update(2);
  await expect.poll(() => b.document.querySelectorAll('.turn-diff-file > summary').length).toBe(0);
});

it('renders actual four-day/one-day residency and offers non-destructive release next to delete', async () => {
  const b = await browser();
  const first = b.state.sessions[0];
  b.state.sessions = [
    { ...first, retention_days: 4 },
    { ...first, id: 'short' as never, created_seq: 2, retention_days: 1 },
    { ...first, id: 'cold' as never, created_seq: 3, retention_days: 0 },
  ];
  b.update();
  await expect.poll(() => b.document.querySelectorAll('.history-row').length).toBe(3);
  expect(
    b.document
      .querySelector('[data-session-id="session"] .session-number')
      ?.classList.contains('alive-long'),
  ).toBe(true);
  expect(
    b.document
      .querySelector('[data-session-id="short"] .session-number')
      ?.classList.contains('alive-short'),
  ).toBe(true);
  expect(b.document.querySelector('[data-session-id="cold"] .session-number')?.className).toBe(
    'session-number',
  );
  const release = b.document.querySelector<HTMLButtonElement>(
    '[data-session-id="short"] .history-release',
  )!;
  expect(release.nextElementSibling?.classList.contains('history-delete')).toBe(true);
  release.click();
  expect(b.sent.at(-1)).toEqual({ type: 'release_session', session: 'short', confirmed: false });
  expect(
    b.document.querySelector<HTMLButtonElement>('[data-session-id="cold"] .history-release')!
      .disabled,
  ).toBe(true);
});

it('automatically reads finished-turn diff and renders the classic header without a review button', async () => {
  const b = await browser();
  b.state.view = {
    ...b.state.view!,
    entries: [
      {
        seq: 1,
        id: entryId.parse('user'),
        turn: 'finished' as never,
        role: 'User',
        message: null,
        image: null,
        text: { Inline: { text: 'change' } },
      },
    ],
  };
  b.update();
  await expect
    .poll(() => b.sent.some((m) => m.type === 'read_turn_diff' && m.automatic))
    .toBe(true);
  b.post({
    type: 'turn_diff',
    session: 'session',
    turn: 'finished',
    diff: {
      status: 'partial',
      files: [
        {
          path: 'a.txt',
          status: 'modified',
          added: 3,
          removed: 1,
          before: null,
          after: null,
          patch: null,
          old_mode: 33188,
          new_mode: 33188,
          omitted: 'size',
          before_hash: null,
          after_hash: null,
        },
      ],
      added: 3,
      removed: 1,
      warnings: [],
      next_offset: null,
    },
  });
  await expect
    .poll(() => b.document.querySelector('.turn-diff-header')?.textContent)
    .toContain('本轮修改 · 1 个文件 · +3 −1（部分结果）');
  expect(b.document.querySelector('.turn-review-action')).toBeNull();
  const header = b.document.querySelector('.turn-diff-header')!;
  expect(header.textContent).toContain('查看总 Diff');
  expect(header.textContent).toContain('撤回本轮修改');
  expect(b.document.querySelector<HTMLDetailsElement>('.turn-diff-files')!.open).toBe(true);
  expect(b.document.querySelector('.turn-diff-notes')?.textContent).toContain(
    '1 个文件未采集文本内容',
  );
  expect(
    [...header.querySelectorAll('button')].find((x) => x.textContent === '撤回本轮修改')!.disabled,
  ).toBe(true);
});

it('offers full Markdown export as a distinct user action for the selected session', async () => {
  const b = await browser();
  b.update();
  const exportButton = [...b.document.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === '导出 Markdown',
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
    (button) => button.getAttribute('aria-label') === '从此处分支',
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
  expect(b.sent.some((m) => m.type === 'read_image')).toBe(false);
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === '加载图片')!
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
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
  expect(
    [...b.document.querySelectorAll('button')].find((button) => button.id === 'send')!.disabled,
  ).toBe(false);
  expect(b.document.querySelector('#error-message')!.textContent).toBe('worker exited');
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
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
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
        (button) => button.textContent === '取消分支操作',
      ),
    )
    .toBe(true);
  [...b.document.querySelectorAll('button')]
    .find((button) => button.textContent === '取消分支操作')!
    .click();
  expect(b.sent.at(-1)).toEqual({ type: 'cancel_fork', operation: 'original-fork' });
});

it('clears accepted Pi input immediately and restores it if an autonomous wake rejects it', async () => {
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
  expect(prompt.value).toBe('');
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
  await expect.poll(() => b.document.body.textContent).toContain('已恢复草稿');
  expect(prompt.value).toBe('keep this input');
});

it('keeps the composer clear during Pi thinking and never overwrites a newer draft on rejection', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  prompt.value = 'accepted input';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  b.accept('session', { parts: [{ type: 'text', text: 'accepted input' }] }, 0);
  expect(prompt.value).toBe('');
  b.state.view!.view!.active_turn = 'user-turn' as never;
  b.state.view!.view!.status = 'Running';
  b.state.view = {
    ...b.state.view!,
    entries: [
      {
        seq: 1,
        id: entryId.parse('input'),
        turn: 'user-turn' as never,
        role: 'User',
        text: { Inline: { text: 'accepted input' } },
        message: null,
        image: null,
      },
    ],
  };
  b.update(2);
  await expect.poll(() => b.document.body.textContent).toContain('accepted input');
  expect(prompt.value).toBe('');
  prompt.value = 'new draft';
  prompt.dispatchEvent(new dom!.window.Event('input'));
  b.state.view = {
    ...b.state.view!,
    entries: [
      ...b.state.view!.entries,
      {
        seq: 2,
        id: entryId.parse('rejection'),
        turn: 'user-turn' as never,
        role: 'Agent',
        text: { Inline: { text: 'rejected' } },
        message: 'pi-workbench-input-rejected' as never,
        image: null,
      },
    ],
  };
  b.update(3);
  await expect.poll(() => b.document.body.textContent).toContain('rejected');
  expect(prompt.value).toBe('new draft');
});

it('dismisses a red error across updates but shows a new operation failure', async () => {
  const b = await browser();
  b.state.error = 'provider unavailable';
  b.update();
  const banner = b.document.querySelector<HTMLElement>('#error')!;
  await expect.poll(() => banner.hidden).toBe(false);
  b.document.querySelector<HTMLButtonElement>('#dismiss-error')!.click();
  expect(banner.hidden).toBe(true);
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(banner.hidden).toBe(true);
  b.state.operations = [
    {
      operation: operationId.parse('new-failure'),
      method: 'discover',
      session: 'session' as never,
      status: 'failed',
      error: 'provider unavailable',
    },
  ];
  b.update(3);
  await expect.poll(() => banner.hidden).toBe(false);
  expect(b.document.querySelector('#error-message')!.textContent).toContain('provider unavailable');
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
    .find((row) => row.getAttribute('aria-label') === '添加上下文')!
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
  expect(
    b.document.querySelector<HTMLInputElement>('input[aria-label="显示思考过程"]')!.checked,
  ).toBe(false);
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
  const agentArticle = b.document.querySelector('article.assistant');
  const plan = b.document.querySelector('#plan details')!;
  expect(b.document.querySelector('#transcript #plan')).toBeNull();
  const process = b.document.querySelector<HTMLDetailsElement>('.turn-process')!;
  process.open = true;
  process.dispatchEvent(new dom!.window.Event('toggle'));
  b.update(2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(b.document.querySelector('#plan details')).toBe(plan);
  expect(b.document.querySelector('article.assistant')).toBe(agentArticle);
  expect(b.document.querySelector<HTMLDetailsElement>('.turn-process')!.open).toBe(true);
  const checkbox = b.document.querySelector<HTMLInputElement>('input[aria-label="显示思考过程"]')!;
  checkbox.checked = false;
  checkbox.dispatchEvent(new dom!.window.Event('change'));
  await expect.poll(() => b.document.querySelectorAll('article.thought').length).toBe(0);
  expect(b.document.querySelectorAll('article.assistant')).toHaveLength(1);
  expect(b.saved()).toMatchObject({ preferences: { showThoughts: false } });
});

it('does not clear an edited-back draft on late acceptance and requires the original operation', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  prompt.value = 'same';
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
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
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
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
    (button) => button.getAttribute('aria-label') === '复制消息',
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
  expect(b.saved()).toMatchObject({ preferences: { composerHeight: 156, sessionRows: 4 } });
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

it('keeps history collapsed and harness navigation separate from starting work, while preserving drafts', async () => {
  const b = await browser();
  b.update();
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  await expect.poll(() => prompt.disabled).toBe(false);
  const history = b.document.querySelector<HTMLElement>('#history')!;
  expect(history.hidden).toBe(true);
  const toggle = b.document.querySelector<HTMLButtonElement>('[aria-label="历史记录"]')!;
  toggle.click();
  expect(history.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  prompt.value = 'keep this Pi draft';
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
  const harness = b.document.querySelector<HTMLSelectElement>('#harness-switch')!;
  harness.value = 'Codex';
  harness.dispatchEvent(new dom!.window.Event('change', { bubbles: true }));
  expect(b.sent.at(-1)).toEqual({ type: 'clear_selection' });
  expect(b.sent.some((message) => message.type === 'create' || message.type === 'execute')).toBe(
    false,
  );
  expect(b.saved()).toMatchObject({ drafts: [['session', 'keep this Pi draft']] });
});

it('updates the context ring on usage deltas without replacing focused provider settings', async () => {
  const b = await browser();
  b.state.view!.view!.catalogue.models = [{ id: 'test' as never, name: 'Test' }];
  b.state.view!.view!.catalogue.current_model = 'test' as never;
  b.state.view!.view!.usage.context_used = 25;
  b.state.view!.view!.usage.context_size = 100;
  b.update();
  await expect.poll(() => b.document.querySelector('[aria-label=model]')).not.toBeNull();
  const selector = b.document.querySelector<HTMLSelectElement>('[aria-label=model]')!;
  selector.focus();
  expect(b.document.querySelector('#usage-fill')!.getAttribute('stroke-dasharray')).toBe('25 100');
  b.state.view!.view!.usage.context_used = 75;
  b.update(2);
  await expect
    .poll(() => b.document.querySelector('#usage-fill')!.getAttribute('stroke-dasharray'))
    .toBe('75 100');
  expect(b.document.querySelector('[aria-label=model]')).toBe(selector);
  expect(b.document.activeElement).toBe(selector);
  expect(b.document.querySelector('[aria-label=mode]')).toBeNull();
});

it('restores the offline Markdown preview without starting a host task, and keeps empty Send disabled', async () => {
  const b = await browser();
  b.state.sessions = [];
  b.state.selected = undefined;
  b.state.view = undefined;
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLButtonElement>('#new')?.disabled)
    .toBe(false);
  const before = b.sent.length;
  b.document.querySelector<HTMLButtonElement>('#demo')!.click();
  await expect
    .poll(() => b.document.querySelector('#messages')?.textContent)
    .toContain('离线渲染预览');
  expect(b.document.querySelector('#status')?.textContent).toBe('渲染预览 · 离线');
  expect(b.document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
  expect(b.sent).toHaveLength(before);
});

it('uses the history trash control to select first and require a second explicit deletion click', async () => {
  const b = await browser();
  b.update();
  await expect.poll(() => b.document.querySelectorAll('.history-delete').length).toBe(1);
  b.document.querySelector<HTMLButtonElement>('.history-delete')!.click();
  expect(b.sent.some((m) => m.type === 'execute')).toBe(false);
  await expect
    .poll(() => b.document.querySelector('.history-delete')?.getAttribute('aria-label'))
    .toMatch(/^确认删除会话/);
  b.document.querySelector<HTMLButtonElement>('.history-delete')!.click();
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'remove', session: 'session' },
  });
});

it('folds settled intermediate narration but keeps final text and output images in the conversation', async () => {
  const b = await browser();
  b.state.view = {
    ...b.state.view!,
    entries: [
      {
        seq: 1,
        id: entryId.parse('step'),
        turn: 'turn' as never,
        role: 'Agent',
        message: 'step-message' as never,
        image: null,
        text: { Inline: { text: '先检查文件。' } },
      },
      {
        seq: 2,
        id: entryId.parse('image-row'),
        turn: 'turn' as never,
        role: 'Agent',
        message: 'image-message' as never,
        image: imageRef.parse({
          id: 'image',
          mime: 'image/png',
          bytes: 24,
          sha256: 'a'.repeat(64),
        }),
        text: { Inline: { text: '' } },
      },
      {
        seq: 3,
        id: entryId.parse('final'),
        turn: 'turn' as never,
        role: 'Agent',
        message: 'final-message' as never,
        image: null,
        text: { Inline: { text: '最终回答。' } },
      },
    ],
  };
  b.update();
  await expect
    .poll(() => b.document.querySelectorAll('#messages article.assistant').length)
    .toBe(3);
  expect(b.document.querySelector('[data-entry=step]')!.closest('.activity-group')).not.toBeNull();
  expect(b.document.querySelector('[data-entry=final]')!.closest('.activity-group')).toBeNull();
  expect(b.document.querySelector('figure')!.closest('.activity-group')).toBeNull();
  expect(b.document.querySelector<HTMLDetailsElement>('.activity-group')!.open).toBe(false);
});

it('never expands a short history or leaves an invisible tier that needs two collapse clicks', async () => {
  const b = await browser({ preferences: { sessionRows: 16 } });
  b.state.sessions.push({ ...b.state.sessions[0], id: 'other' as never, created_seq: 2 });
  b.update();
  await expect
    .poll(() => b.document.querySelector('#history-items')?.getAttribute('data-limit'))
    .toBe('4');
  const more = b.document.querySelector<HTMLButtonElement>('[aria-label="展开历史列表"]')!;
  expect(more.disabled).toBe(true);
  expect(more.querySelector('svg')).not.toBeNull();
  more.click();
  b.document.querySelector<HTMLButtonElement>('[aria-label="历史记录"]')!.click();
  expect(b.document.querySelector<HTMLElement>('#history')!.hidden).toBe(false);
  b.document.querySelector<HTMLButtonElement>('[aria-label="收起历史列表"]')!.click();
  expect(b.document.querySelector<HTMLElement>('#history')!.hidden).toBe(true);
  expect(b.saved()).toMatchObject({ preferences: { sessionRows: 4, historyOpen: false } });
});

it('enables only useful history tiers and clamps a saved tier when the result set shrinks', async () => {
  const b = await browser();
  b.state.sessions = Array.from({ length: 12 }, (_, i) => ({
    ...b.state.sessions[0],
    id: `session-${i}` as never,
    created_seq: i + 1,
  }));
  b.update();
  const more = b.document.querySelector<HTMLButtonElement>('[aria-label="展开历史列表"]')!;
  await expect.poll(() => more.disabled).toBe(false);
  more.click();
  await expect
    .poll(() => b.document.querySelector('#history-items')?.getAttribute('data-limit'))
    .toBe('10');
  more.click();
  await expect
    .poll(() => b.document.querySelector('#history-items')?.getAttribute('data-limit'))
    .toBe('16');
  expect(more.disabled).toBe(true);
  b.state.sessions = b.state.sessions.slice(0, 6);
  b.update(2);
  await expect
    .poll(() => b.document.querySelector('#history-items')?.getAttribute('data-limit'))
    .toBe('10');
  expect(more.disabled).toBe(true);
  b.document.querySelector<HTMLButtonElement>('[aria-label="收起历史列表"]')!.click();
  await expect
    .poll(() => b.document.querySelector('#history-items')?.getAttribute('data-limit'))
    .toBe('4');
  expect(more.disabled).toBe(false);
});

it('uses advertised thinking steps, Fast values and model IDs in the combined control without sending a prompt', async () => {
  const b = await browser(),
    snapshot = b.state.view!.view!;
  snapshot.catalogue.models = [
    { id: 'vendor/a' as never, name: 'Model A' },
    { id: 'vendor/b' as never, name: 'Model B' },
  ];
  snapshot.catalogue.current_model = 'vendor/a' as never;
  snapshot.catalogue.selects = [
    {
      id: 'effort',
      name: 'Thinking',
      category: 'thought_level',
      current_value: 'mid',
      choices: [
        { value: 'tiny', name: 'Low' },
        { value: 'mid', name: 'Medium' },
        { value: 'big', name: 'High' },
      ],
    },
    {
      id: 'speed',
      name: 'Fast Mode',
      category: 'other',
      current_value: 'off',
      choices: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  ];
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLButtonElement>('.model-controls-trigger')?.textContent)
    .toContain('Model A · 中');
  const trigger = b.document.querySelector<HTMLButtonElement>('.model-controls-trigger')!;
  trigger.click();
  const dialog = b.document.querySelector<HTMLElement>(
    '[role=dialog][aria-label="模型与思考设置"]',
  )!;
  expect(dialog.hidden).toBe(false);
  const range = b.document.querySelector<HTMLInputElement>('[aria-label="思考强度"]')!;
  expect(range.max).toBe('2');
  expect(range.value).toBe('1');
  range.value = '2';
  range.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
  expect(b.sent.some((m) => m.type === 'execute')).toBe(false);
  range.dispatchEvent(new dom!.window.Event('change', { bubbles: true }));
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'set_option', id: 'effort', value: 'big' },
  });
  const prompt = b.document.querySelector<HTMLTextAreaElement>('#prompt')!;
  prompt.value = 'wait for setting';
  prompt.dispatchEvent(new dom!.window.Event('input', { bubbles: true }));
  expect(b.document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
  prompt
    .closest('form')!
    .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  snapshot.catalogue.selects![0].current_value = 'big';
  b.update(2);
  await expect
    .poll(() => b.document.querySelector<HTMLButtonElement>('[aria-label="Fast Mode"]')!.disabled)
    .toBe(false);
  b.document.querySelector<HTMLButtonElement>('[aria-label="Fast Mode"]')!.click();
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'set_option', id: 'speed', value: 'on' },
  });
  snapshot.catalogue.selects![1].current_value = 'on';
  b.update(3);
  await expect
    .poll(() => b.document.querySelector<HTMLButtonElement>('.model-picker-trigger')!.disabled)
    .toBe(false);
  b.document.querySelector<HTMLButtonElement>('.model-picker-trigger')!.click();
  const option = [
    ...b.document.querySelectorAll<HTMLButtonElement>('.model-picker-options button'),
  ].find((x) => x.textContent === 'Model B')!;
  option.click();
  expect(b.sent.at(-1)).toMatchObject({
    type: 'execute',
    command: { method: 'set_model', model: 'vendor/b' },
  });
  expect(
    b.sent
      .filter((m) => m.type === 'execute')
      .every((m) => m.type === 'execute' && m.command.method !== 'prompt'),
  ).toBe(true);
  dom!.window.document.dispatchEvent(
    new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  expect(dialog.hidden).toBe(true);
  expect(b.document.activeElement).toBe(trigger);
});

it('disables unadvertised Fast and thinking settings and restores the confirmed choice after a rejected setting', async () => {
  const b = await browser(),
    snapshot = b.state.view!.view!;
  snapshot.catalogue.models = [{ id: 'a' as never, name: 'A' }];
  snapshot.catalogue.current_model = 'a' as never;
  b.update();
  await expect
    .poll(() => b.document.querySelector<HTMLButtonElement>('[aria-label="Fast Mode"]')?.disabled)
    .toBe(true);
  expect(b.document.querySelector<HTMLInputElement>('[aria-label="思考强度"]')!.disabled).toBe(
    true,
  );
  snapshot.catalogue.selects = [
    {
      id: 'effort',
      name: 'Thinking',
      category: 'thought_level',
      current_value: 'low',
      choices: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
  b.update(2);
  await expect
    .poll(() => b.document.querySelector<HTMLInputElement>('[aria-label="思考强度"]')!.disabled)
    .toBe(false);
  b.document.querySelector<HTMLButtonElement>('.model-controls-trigger')!.click();
  const range = b.document.querySelector<HTMLInputElement>('[aria-label="思考强度"]')!;
  range.value = '1';
  range.dispatchEvent(new dom!.window.Event('change', { bubbles: true }));
  b.state.error = 'setting rejected';
  b.update(3);
  await expect.poll(() => range.value).toBe('0');
  expect(b.document.querySelector('.model-thinking-label')!.textContent).toBe('低');
});

it('reads the newly finished turn without an intersection callback and displays a zero-change result', async () => {
  const b = await browser(undefined, true);
  const view = b.state.view!;
  b.state.view = {
    ...view,
    view: { ...view.view!, status: 'Running', active_turn: 'live' as never },
    entries: [
      {
        seq: 1,
        id: entryId.parse('input'),
        turn: 'live' as never,
        role: 'User',
        message: null,
        image: null,
        text: { Inline: { text: 'hello' } },
      },
    ],
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('.message.user').length).toBe(1);
  expect(b.sent.some((m) => m.type === 'read_turn_diff')).toBe(false);
  b.state.view = {
    ...b.state.view!,
    view: { ...b.state.view!.view!, status: 'Idle', active_turn: null },
    entries: [
      ...b.state.view!.entries,
      {
        seq: 2,
        id: entryId.parse('answer'),
        turn: 'live' as never,
        role: 'Agent',
        message: null,
        image: null,
        text: { Inline: { text: 'done' } },
      },
    ],
  };
  b.update(2);
  await expect
    .poll(() => b.sent.some((m) => m.type === 'read_turn_diff' && m.turn === 'live' && m.automatic))
    .toBe(true);
  expect(b.document.querySelectorAll('.assistant .message-reuse')).toHaveLength(0);
  const reuse = b.document.querySelector<HTMLButtonElement>('.user .message-reuse')!;
  expect(reuse.textContent).toBe('重用');
  reuse.click();
  expect(b.document.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe('hello');
  b.post({
    type: 'turn_diff',
    session: 'session',
    turn: 'live',
    diff: { status: 'complete', files: [], added: 0, removed: 0, warnings: [], next_offset: null },
  });
  await expect
    .poll(() => b.document.querySelector('.turn-diff-header')?.textContent)
    .toContain('本轮修改 · 0 个文件');
  expect(b.document.querySelector('.turn-diff-files')?.textContent).toContain(
    '本轮未检测到文件净变化',
  );
  expect(b.document.querySelector('.undo-turn')).toBeNull();
});

it('renders a whole archived formula and exposes only the arrow for returning to latest turns', async () => {
  const b = await browser();
  const text = '\\frac{a}{b} = x^2';
  const ref = {
    id: 'math-content',
    kind: 'Text',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
  b.state.view = {
    ...b.state.view!,
    historical: true,
    earlier: { version: 3, session: 'session' as never, max_entry_seq: 4, before_seq: 1 },
    entries: [
      {
        seq: 1,
        id: entryId.parse('begin'),
        turn: 'math' as never,
        role: 'Agent',
        message: 'math-message' as never,
        image: null,
        text: { Inline: { text: '$$\n' } },
      },
      {
        seq: 2,
        id: entryId.parse('middle'),
        turn: 'math' as never,
        role: 'Agent',
        message: 'math-message' as never,
        image: null,
        text: { Archived: { content: ref as never } },
      },
      {
        seq: 3,
        id: entryId.parse('end'),
        turn: 'math' as never,
        role: 'Agent',
        message: 'math-message' as never,
        image: null,
        text: { Inline: { text: '\n$$\n完整结尾' } },
      },
    ],
    resolvedText: { 'math-content': text },
  };
  b.update();
  await expect.poll(() => b.document.querySelectorAll('.assistant .katex').length).toBe(1);
  expect(b.document.querySelectorAll('.assistant .katex .mfrac')).toHaveLength(1);
  expect(b.document.querySelector('.assistant')?.textContent).toContain('完整结尾');
  expect(b.document.querySelectorAll('.assistant')).toHaveLength(1);
  expect(
    [...b.document.querySelectorAll('button')].some(
      (n) => n.textContent === '加载更早消息（20 轮）',
    ),
  ).toBe(true);
  expect(
    [...b.document.querySelectorAll('button')].filter(
      (n) => n.getAttribute('aria-label') === '回到最新消息',
    ),
  ).toHaveLength(1);
  const arrow = b.document.querySelector<HTMLButtonElement>('#bottom')!;
  expect(arrow.hidden).toBe(false);
  arrow.click();
  expect(b.sent.at(-1)).toEqual({ type: 'latest', session: 'session' });
});
