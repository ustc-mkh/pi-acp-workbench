import type { Entry } from '../src/shared';
export type TranscriptBlock =
  | { kind: 'message'; entry: Entry }
  | { kind: 'activity'; id: string; entries: Entry[]; running: boolean };

/** Stream narration in the live turn; fold adjacent tools/thoughts, then the settled trace. */
export function transcriptBlocks(
  entries: Entry[],
  busy = false,
  activeTurnId?: string | null,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let turn: Entry[] = [];
  let turnId: string | undefined;
  const flush = (running = false) => {
    if (running) {
      let steps: Entry[] = [];
      const flushSteps = () => {
        if (steps.length)
          blocks.push({ kind: 'activity', id: steps[0].id, entries: steps, running: true });
        steps = [];
      };
      for (const entry of turn) {
        if (entry.role === 'tool' || entry.role === 'thought') steps.push(entry);
        else {
          flushSteps();
          blocks.push({ kind: 'message', entry });
        }
      }
      flushSteps();
      turn = [];
      return;
    }
    let last = -1;
    const lastAnswer = [...turn].reverse().findIndex((entry) => entry.role === 'assistant');
    const answer = lastAnswer < 0 ? -1 : turn.length - 1 - lastAnswer;
    if (answer >= 0) {
      const activity = turn.filter(
        (entry, i) =>
          i < answer || (i > answer && (entry.role === 'tool' || entry.role === 'thought')),
      );
      if (activity.length)
        blocks.push({ kind: 'activity', id: activity[0].id, entries: activity, running: false });
      for (const entry of turn.slice(answer))
        if (entry.role !== 'tool' && entry.role !== 'thought')
          blocks.push({ kind: 'message', entry });
      turn = [];
      return;
    }
    turn.forEach((entry, i) => {
      if (entry.role === 'tool' || entry.role === 'thought') last = i;
    });
    if (last >= 0)
      blocks.push({
        kind: 'activity',
        id: turn[0].id,
        entries: turn.slice(0, last + 1),
        running: false,
      });
    for (const entry of turn.slice(last + 1)) blocks.push({ kind: 'message', entry });
    turn = [];
  };
  for (const entry of entries) {
    if (entry.role === 'user') {
      flush();
      blocks.push({ kind: 'message', entry });
      turnId = undefined;
    } else {
      if (entry.turnId && entry.turnId !== turnId) {
        flush();
        turnId = entry.turnId;
      }
      turn.push(entry);
    }
  }
  flush(busy && (!activeTurnId || turnId === activeTurnId));
  return blocks;
}

function reconcile(parent: HTMLElement, children: HTMLElement[]) {
  children.forEach((child, i) => {
    if (parent.children[i] !== child) parent.insertBefore(child, parent.children[i] || null);
  });
  const keep = new Set(children);
  for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove();
}

export class TranscriptView {
  private runningEntries = new Set<string>();
  private messages = new Map<string, { entry: Entry; node: HTMLElement }>();
  private groups = new Map<
    string,
    {
      node: HTMLDetailsElement;
      summary: HTMLElement;
      body: HTMLElement;
      running: boolean;
      renderBody: () => void;
    }
  >();
  constructor(
    private root: HTMLElement,
    private render: (entry: Entry) => HTMLElement,
    private expanded = false,
  ) {}
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    for (const group of this.groups.values()) {
      group.node.open = expanded;
      if (expanded) group.renderBody();
    }
  }
  update(entries: Entry[], busy: boolean, activeTurnId?: string | null) {
    const ids = new Set(entries.map((entry) => entry.id));
    for (const [id, cached] of this.messages)
      if (!ids.has(id)) {
        cached.node.remove();
        this.messages.delete(id);
      }
    const message = (entry: Entry) => {
      let cached = this.messages.get(entry.id);
      if (!cached || cached.entry !== entry) {
        const node = this.render(entry);
        if (node instanceof HTMLDetailsElement && cached?.node instanceof HTMLDetailsElement)
          node.open = cached.node.open;
        // Restored open tools must materialize before reading terminal scroll
        // geometry; the native toggle event is asynchronous.
        if (node instanceof HTMLDetailsElement && node.open)
          node.dispatchEvent(new Event('pi:materialize'));
        const previousOutput = cached?.node.querySelector<HTMLElement>('.terminal-output');
        const nextOutput = node.querySelector<HTMLElement>('.terminal-output');
        const follow =
          !previousOutput ||
          previousOutput.scrollHeight - previousOutput.scrollTop - previousOutput.clientHeight < 24;
        const scrollTop = previousOutput?.scrollTop || 0;
        cached?.node.replaceWith(node);
        if (nextOutput)
          requestAnimationFrame(() => {
            nextOutput.scrollTop = follow ? nextOutput.scrollHeight : scrollTop;
          });
        cached = { entry, node };
        this.messages.set(entry.id, cached);
      }
      cached.node.classList.toggle('running-turn', runningIds.has(entry.id));
      return cached.node;
    };
    const blocks = transcriptBlocks(entries, busy, activeTurnId),
      active = new Set<string>();
    // The tail run alone is live; an autonomous wake is a new turn even without a user entry.
    let start = 0;
    let turnId: string | undefined;
    entries.forEach((entry, index) => {
      if (entry.role === 'user') {
        start = index;
        turnId = undefined;
      } else if (entry.turnId && entry.turnId !== turnId) {
        start = index;
        turnId = entry.turnId;
      }
    });
    const runningIds = new Set(
      busy && (!activeTurnId || turnId === activeTurnId)
        ? entries.slice(start).map((entry) => entry.id)
        : [],
    );
    const nodes = blocks.map((block) => {
      if (block.kind === 'message') return message(block.entry);
      active.add(block.id);
      const running = block.running;
      let group = this.groups.get(block.id);
      if (!group) {
        const node = document.createElement('details');
        node.className = 'activity-group';
        node.open = this.expanded;
        const summary = document.createElement('summary'),
          body = document.createElement('div');
        body.className = 'activity-body';
        node.append(summary, body);
        group = { node, summary, body, running, renderBody: () => {} };
        const current = group;
        node.addEventListener('toggle', () => {
          if (node.open) current.renderBody();
        });
        this.groups.set(block.id, group);
      }
      const tools = block.entries.filter((e) => e.role === 'tool').length,
        thoughts = block.entries.filter((e) => e.role === 'thought').length;
      if (
        !running &&
        (group.running || block.entries.some((entry) => this.runningEntries.has(entry.id)))
      )
        group.node.open = false;
      group.running = running;
      group.summary.textContent = `${running ? '处理中' : '执行过程'} · ${tools} 次工具调用${thoughts ? ` · ${thoughts} 段思考` : ''}`;
      group.node.classList.toggle('running', running);
      const current = group;
      group.renderBody = () => reconcile(current.body, block.entries.map(message));
      if (group.node.open) group.renderBody();
      else
        reconcile(
          group.body,
          block.entries.flatMap((entry) => {
            const cached = this.messages.get(entry.id);
            return cached ? [cached.node] : [];
          }),
        );
      return group.node;
    });
    for (const [id, group] of this.groups)
      if (!active.has(id)) {
        group.node.remove();
        this.groups.delete(id);
      }
    reconcile(this.root, nodes);
    for (const [id, cached] of this.messages)
      cached.node.classList.toggle('running-turn', runningIds.has(id));
    this.runningEntries = runningIds;
  }
}
