import { element, button } from './workbench-elements';
import { MessageProjection } from '../src/workbench-messages';
import { reconcile } from './workbench-dom';
import { renderDiagrams } from './diagrams';
import type { DiffView } from './workbench-diff-view';
import type { ImageView } from './workbench-image-view';
import type { Preferences } from './workbench-preferences';
import {
  contentId,
  type ContentRef,
  type ClientCommand,
  type SessionView,
} from '../src/workbench-protocol';
import type { UiCommand, WorkbenchUiState, WorkbenchUiMessage } from '../src/workbench-ui';

interface HistoryPorts {
  transcript: HTMLElement;
  messages: HTMLElement;
  preferences: Preferences;
  disclosure(key: string, fallback?: boolean): HTMLDetailsElement;
  diffView: DiffView;
  imageView: ImageView;
  markdown(text: string): string;
  send(command: UiCommand): void;
  mutate(command: ClientCommand): void;
  getState(): WorkbenchUiState | undefined;
  schedule(): void;
  reusePrompt(text: string): void;
}
export function createHistoryView({
  transcript,
  messages,
  preferences,
  disclosure,
  diffView,
  imageView,
  markdown,
  send,
  mutate,
  getState,
  schedule,
  reusePrompt,
}: HistoryPorts) {
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
                diffView.requestAutomaticDiff(node.dataset.sessionId, node.dataset.turn);
            }
          },
          { root: transcript, rootMargin: '200px' },
        )
      : undefined;

  const observedHistoryText = new Set<HTMLElement>();
  const visibleHistoryText = new Set<HTMLElement>();
  let historyTextFrame: number | undefined;
  let lastHistoryTextRequest = '';
  function reportVisibleHistoryText() {
    if (historyTextFrame !== undefined) return;
    historyTextFrame = requestAnimationFrame(() => {
      historyTextFrame = undefined;
      const state = getState();
      const session = state?.view?.view?.id;
      if (!session || state?.view?.status !== 'ready') return;
      const ids = new Set<ReturnType<typeof contentId.parse>>();
      for (const node of visibleHistoryText) {
        if (node.isConnected && node.dataset.historyText)
          ids.add(contentId.parse(node.dataset.historyText));
        if (ids.size === 128) break;
      }
      const visible = [...ids];
      const key = JSON.stringify([session, visible]);
      if (key === lastHistoryTextRequest || (!lastHistoryTextRequest && !visible.length)) return;
      lastHistoryTextRequest = key;
      send({ type: 'visible_history_text', session, ids: visible });
    });
  }
  const historyTextObserver =
    typeof window.IntersectionObserver === 'function'
      ? new window.IntersectionObserver(
          (entries) => {
            for (const { target, isIntersecting } of entries) {
              const node = target as HTMLElement;
              if (isIntersecting && observedHistoryText.has(node)) visibleHistoryText.add(node);
              else visibleHistoryText.delete(node);
            }
            reportVisibleHistoryText();
          },
          { root: transcript, rootMargin: '150px' },
        )
      : undefined;
  function observeHistoryText() {
    if (!historyTextObserver) return;
    const nodes = new Set(messages.querySelectorAll<HTMLElement>('[data-history-text]'));
    for (const node of observedHistoryText) {
      if (nodes.has(node)) continue;
      historyTextObserver.unobserve(node);
      observedHistoryText.delete(node);
      if (visibleHistoryText.delete(node)) reportVisibleHistoryText();
    }
    for (const node of nodes) {
      if (observedHistoryText.has(node)) continue;
      historyTextObserver.observe(node);
      observedHistoryText.add(node);
    }
  }

  const contentPages = new Map<
    string,
    { ref: ContentRef; offset: number; text: string; next: number | null }
  >();
  function contentNode(ref: ContentRef, session: SessionView['id'], preview?: string) {
    const box = element('section');
    const page = contentPages.get(ref.id);
    box.append(element('small', `Archived ${ref.kind} · ${ref.bytes} bytes`));
    box.append(
      button(page ? 'First content page' : 'Read content', () =>
        send({ type: 'read_content', session, ref, offset: 0 }),
      ),
    );
    if (!page && preview) box.append(element('pre', preview + '…'));
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
  let userInputs: string[] = [];
  let messageProjection = new MessageProjection();
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
    const state = getState();
    const rows = state?.view?.entries || [];
    const oldest = rows[0]?.seq;
    const previousOldest = Number(messages.dataset.oldestSeq);
    const prepended = Boolean(
      state?.view?.historical && oldest !== undefined && oldest < previousOldest,
    );
    if (oldest === undefined) delete messages.dataset.oldestSeq;
    else messages.dataset.oldestSeq = String(oldest);
    const streaming = snapshot.status === 'Running';
    const scroll = transcript.scrollTop;
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
    const turns = new Map<
      string,
      { box: HTMLElement; process: HTMLDetailsElement; body: HTMLElement }
    >();
    if (state?.view?.earlier)
      output.append(
        button(
          '加载更早消息（20 轮）',
          () => send({ type: 'earlier', session: snapshot.id }),
          !!state.view.loadingEarlier || state.view.status !== 'ready',
        ),
      );
    const projected = messageProjection.update(rows);
    const lastAnswers = new Map<string, string>();
    for (const message of projected)
      if (message.row.role === 'Agent' && !message.row.image)
        lastAnswers.set(message.row.turn, message.key);
    userInputs = [];
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
      if (message.row.role === 'User' && !message.row.image && completeText?.trim())
        userInputs.push(completeText);
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
      if (inActivity && (row.role !== 'Thought' || preferences.showThoughts)) folded.add(row.turn);
      let turn = turns.get(row.turn);
      if (!turn) {
        const box = element('section');
        box.dataset.turn = row.turn;
        box.className = 'turn';
        box.dataset.sessionId = snapshot.id;
        const previousProcess = [...messages.querySelectorAll<HTMLElement>('[data-turn]')]
          .find((node) => node.dataset.turn === row.turn)
          ?.querySelector('.turn-process');
        if (previousProcess?.classList.contains('running') && snapshot.active_turn !== row.turn)
          preferences.setOpen(`${snapshot.id}:turn:${row.turn}`, false);
        const process = disclosure(`${snapshot.id}:turn:${row.turn}`, preferences.activityExpanded);
        process.className = 'turn-process activity-group';
        process.append(element('summary', '思考与工具调用'));
        const activityBody = element('div');
        activityBody.className = 'activity-body';
        process.append(activityBody);
        process.addEventListener('toggle', () => {
          if (process.isConnected && process.open)
            send({ type: 'read_tools', session: snapshot.id, turn: row.turn });
        });
        box.append(process);
        const diff = diffView.render(snapshot, row.turn, busy);
        if (diff) box.append(diff);
        turn = { box, process, body: activityBody };
        turns.set(row.turn, turn);
        output.append(box);
      }
      if (row.role === 'Thought' && !preferences.showThoughts) continue;
      const definition = JSON.stringify([
        row.id,
        message.entries.at(-1)!.id,
        message.entries.length,
        row.role !== 'User' && snapshot.active_turn === row.turn,
        row.role !== 'User' && snapshot.active_turn === row.turn && streaming,
        message.entries.flatMap((entry) =>
          'Archived' in entry.text
            ? [
                contentPages.get(entry.text.Archived.content.id),
                state?.view?.resolvedText?.[entry.text.Archived.content.id]?.length,
              ]
            : [],
        ),
        row.image ? [...imageView.status(row.image.id)] : null,
      ]);
      const previous = previousArticles.get(message.key);
      if (previous?.dataset.definition === definition) {
        const placeholder = element('article');
        placeholder.dataset.entry = message.key;
        placeholder.dataset.definition = definition;
        if (inActivity) turn.body.append(placeholder);
        else if (row.role === 'User') turn.box.insertBefore(placeholder, turn.process);
        else turn.box.append(placeholder);
        continue;
      }
      const article = element('article');
      article.dataset.definition = definition;
      article.dataset.entry = message.key;
      article.className =
        'message ' + (row.role === 'Agent' ? 'assistant' : row.role.toLowerCase());
      article.classList.toggle(
        'running-turn',
        row.role !== 'User' && snapshot.active_turn === row.turn,
      );
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
            reusePrompt(text);
          }),
        );
      }
      const content = element('div');
      content.className = 'message-body';
      if ('Inline' in row.text) {
        // Parse all received Markdown on each bounded streaming paint. Cutting a
        // prefix mid-fence/emphasis leaves complete syntax in a plain-text tail.
        const text = row.text.Inline.text;
        const checkpoint = Math.min(text.length, 256 * 1024);
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
            const anchor = event.currentTarget as HTMLAnchorElement;
            const url = anchor.dataset.fileLink ?? anchor.getAttribute('href');
            if (url) send({ type: 'open_link', url });
          };
        });
        for (const copy of parsed.querySelectorAll<HTMLButtonElement>('.copy-code'))
          copy.onclick = (event) => {
            const copy = event.currentTarget as HTMLButtonElement;
            const text = copy.parentElement?.querySelector('code')?.textContent ?? '';
            send({ type: 'copy_text', text });
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
          if ('Archived' in part.text) {
            const { content: ref, preview } = part.text.Archived;
            const node = contentNode(ref, snapshot.id, preview);
            if (!contentPages.has(ref.id)) node.dataset.historyText = ref.id;
            content.append(node);
          } else content.append(element('pre', part.text.Inline.text));
        }
      if (row.role === 'Thought') {
        const details = disclosure(`${snapshot.id}:thought:${row.id}`);
        details.className = 'thought';
        content.classList.add('thought-body');
        details.append(element('summary', '思考过程'), content);
        article.append(details);
      } else article.append(content);
      if (row.image) article.append(imageView.node(row.image, snapshot.id));
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
      if (row.role === 'Agent' || row.role === 'User') article.append(actions);
      if (inActivity) turn.body.append(article);
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
    if (latestFinished) diffView.requestAutomaticDiff(snapshot.id, latestFinished.turn);
    if (!diffObserver)
      for (const turn of [...visibleTurns].slice(-16))
        diffView.requestAutomaticDiff(snapshot.id, turn);
    for (const turn of visibleTurns) {
      const process = turns.get(turn)!.process;
      process.hidden = !folded.has(turn) && !state?.view?.tools.some((tool) => tool.turn === turn);
      const thoughtCount = preferences.showThoughts
        ? projected.filter((message) => message.row.turn === turn && message.row.role === 'Thought')
            .length
        : 0;
      const toolCount = state?.view?.tools.filter((tool) => tool.turn === turn).length || 0;
      process.querySelector('summary')!.textContent =
        `${snapshot.active_turn === turn ? '处理中' : '执行过程'} · ${toolCount} 次工具调用${thoughtCount ? ` · ${thoughtCount} 段思考` : ''}`;
      process.classList.toggle('running', snapshot.active_turn === turn);
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
      details.className = 'message tool';
      const summary = element(
        'summary',
        `${tool.status === 'Completed' ? '✓' : tool.status === 'Failed' ? '×' : '◇'} ${tool.title}`,
      );
      const badge = element(
        'span',
        {
          Pending: '等待',
          InProgress: '执行中',
          Completed: '完成',
          Failed: '失败',
        }[tool.status],
      );
      badge.className = `badge ${tool.status === 'InProgress' ? 'in_progress' : tool.status.toLowerCase()}`;
      summary.append(badge);
      details.append(summary);
      const bodyNode = element('div');
      bodyNode.className = 'tool-body';
      details.addEventListener('toggle', () => {
        if (!details.isConnected || !details.open) return;
        const current = getState()?.view?.tools.find(
          (item) => item.id === tool.id && item.turn === tool.turn,
        );
        for (const body of current?.content || []) {
          const refs =
            'Text' in body
              ? [body.Text.content]
              : 'Diff' in body
                ? [body.Diff.old_text, body.Diff.new_text]
                : 'ResourceText' in body
                  ? [body.ResourceText.content]
                  : [];
          for (const ref of refs)
            if (ref && !contentPages.has(ref.id))
              send({ type: 'read_content', session: snapshot.id, ref, offset: 0 });
        }
      });
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
      // Keep native details as the card root, matching the classic tool layout.
      bodyNode.append(...[...details.children].slice(1));
      details.append(bodyNode);
      turns.get(tool.turn)!.body.append(details);
    }
    reconcile(messages, output);
    observeHistoryText();
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
      restored && anchorOffset !== undefined
        ? transcript.scrollTop + restored.getBoundingClientRect().top - anchorOffset
        : scroll;
    return prepended;
  }

  function receive(raw: Extract<WorkbenchUiMessage, { type: 'content' | 'content_error' }>) {
    const state = getState();
    if (raw.session !== state?.selected) return;
    if (raw.type === 'content') {
      const ref = raw.ref,
        slice = raw.slice;
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
    } else {
      const ref = raw.ref;
      contentPages.delete(ref.id);
      schedule();
    }
  }
  function clear() {
    messages.replaceChildren();
    diffObserver?.disconnect();
    historyTextObserver?.disconnect();
    if (historyTextFrame !== undefined) cancelAnimationFrame(historyTextFrame);
    historyTextFrame = undefined;
    observedHistoryText.clear();
    visibleHistoryText.clear();
    lastHistoryTextRequest = '';
    userInputs = [];
    messageProjection = new MessageProjection();
    markdownCache.clear();
    contentPages.clear();
    delete messages.dataset.oldestSeq;
  }
  return { render: renderTranscript, receive, clear, userInputs: () => userInputs };
}
