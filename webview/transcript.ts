import type { Entry } from '../src/shared';
export type TranscriptBlock =
  | { kind: 'message'; entry: Entry }
  | { kind: 'activity'; id: string; entries: Entry[] };

/** Stream narration in the live turn; fold adjacent tools/thoughts, then the settled trace. */
export function transcriptBlocks(entries: Entry[], busy = false): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let turn: Entry[] = [];
  const flush = (running = false) => {
    if (running) {
      let steps: Entry[] = [];
      const flushSteps = () => {
        if (steps.length) blocks.push({ kind: 'activity', id: steps[0].id, entries: steps });
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
      if (activity.length) blocks.push({ kind: 'activity', id: activity[0].id, entries: activity });
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
      blocks.push({ kind: 'activity', id: turn[0].id, entries: turn.slice(0, last + 1) });
    for (const entry of turn.slice(last + 1)) blocks.push({ kind: 'message', entry });
    turn = [];
  };
  for (const entry of entries) {
    if (entry.role === 'user') {
      flush();
      blocks.push({ kind: 'message', entry });
    } else turn.push(entry);
  }
  flush(busy);
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
    { node: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; running: boolean }
  >();
  constructor(
    private root: HTMLElement,
    private render: (entry: Entry) => HTMLElement,
    private expanded = false,
  ) {}
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    for (const group of this.groups.values()) group.node.open = expanded;
  }
  update(entries: Entry[], busy: boolean) {
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
      return cached.node;
    };
    const blocks = transcriptBlocks(entries, busy),
      active = new Set<string>();
    const nodes = blocks.map((block, index) => {
      if (block.kind === 'message') return message(block.entry);
      active.add(block.id);
      const running =
        busy &&
        !blocks.slice(index + 1).some((b) => b.kind === 'message' && b.entry.role === 'user');
      let group = this.groups.get(block.id);
      if (!group) {
        const node = document.createElement('details');
        node.className = 'activity-group';
        node.open = this.expanded;
        const summary = document.createElement('summary'),
          body = document.createElement('div');
        body.className = 'activity-body';
        node.append(summary, body);
        group = { node, summary, body, running };
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
      reconcile(group.body, block.entries.map(message));
      return group.node;
    });
    for (const [id, group] of this.groups)
      if (!active.has(id)) {
        group.node.remove();
        this.groups.delete(id);
      }
    reconcile(this.root, nodes);
    this.runningEntries = new Set(
      busy
        ? entries
            .slice(entries.map((entry) => entry.role).lastIndexOf('user') + 1)
            .map((entry) => entry.id)
        : [],
    );
  }
}
