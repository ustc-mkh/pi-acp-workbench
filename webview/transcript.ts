import type { Entry } from '../src/shared';
export type TranscriptBlock = {kind:'message';entry:Entry} | {kind:'activity';id:string;entries:Entry[]};

/** Keep the final answer visible; earlier narration, thoughts and tools form one execution trace. */
export function transcriptBlocks(entries: Entry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let turn: Entry[] = [];
  const flush = () => {
    let last = -1;
    turn.forEach((entry, i) => { if(entry.role === 'tool' || entry.role === 'thought') last = i; });
    if (last >= 0) blocks.push({kind:'activity', id:turn[0].id, entries:turn.slice(0,last+1)});
    for (const entry of turn.slice(last+1)) blocks.push({kind:'message',entry});
    turn = [];
  };
  for (const entry of entries) {
    if (entry.role === 'user') { flush(); blocks.push({kind:'message',entry}); }
    else turn.push(entry);
  }
  flush(); return blocks;
}

function reconcile(parent: HTMLElement, children: HTMLElement[]) {
  children.forEach((child, i) => { if(parent.children[i] !== child) parent.insertBefore(child, parent.children[i] || null); });
  const keep = new Set(children);
  for (const child of [...parent.children]) if(!keep.has(child as HTMLElement)) child.remove();
}

export class TranscriptView {
  private messages = new Map<string,{entry:Entry;node:HTMLElement}>();
  private groups = new Map<string,{node:HTMLDetailsElement;summary:HTMLElement;body:HTMLElement}>();
  constructor(private root:HTMLElement, private render:(entry:Entry)=>HTMLElement, private expanded=false) {}
  setExpanded(expanded:boolean) {
    this.expanded = expanded;
    for (const group of this.groups.values()) group.node.open = expanded;
  }
  update(entries:Entry[], busy:boolean) {
    const ids = new Set(entries.map(entry=>entry.id));
    for (const [id, cached] of this.messages) if(!ids.has(id)) {cached.node.remove();this.messages.delete(id);}
    const message = (entry:Entry) => {
      let cached = this.messages.get(entry.id);
      if(!cached || cached.entry !== entry) {
        const node = this.render(entry);
        if(node instanceof HTMLDetailsElement && cached?.node instanceof HTMLDetailsElement) node.open = cached.node.open;
        cached?.node.replaceWith(node);
        cached = {entry,node}; this.messages.set(entry.id,cached);
      }
      return cached.node;
    };
    const blocks = transcriptBlocks(entries), active = new Set<string>();
    const nodes = blocks.map((block,index) => {
      if(block.kind === 'message') return message(block.entry);
      active.add(block.id);
      let group = this.groups.get(block.id);
      if(!group) {
        const node = document.createElement('details'); node.className = 'activity-group'; node.open = this.expanded;
        const summary = document.createElement('summary'), body = document.createElement('div'); body.className = 'activity-body';
        node.append(summary,body); group = {node,summary,body}; this.groups.set(block.id,group);
      }
      const tools = block.entries.filter(e=>e.role==='tool').length, thoughts = block.entries.filter(e=>e.role==='thought').length;
      const running = busy && !blocks.slice(index+1).some(b=>b.kind==='message' && b.entry.role==='user');
      group.summary.textContent = `${running?'处理中':'执行过程'} · ${tools} 次工具调用${thoughts?` · ${thoughts} 段思考`:''}`;
      group.node.classList.toggle('running',running);
      reconcile(group.body,block.entries.map(message));
      return group.node;
    });
    for(const [id,group] of this.groups) if(!active.has(id)) {group.node.remove();this.groups.delete(id);}
    reconcile(this.root,nodes);
  }
}
