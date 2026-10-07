import type { Entry, UiMessage } from '../src/shared';

export function messageActions(
  entry: Entry,
  sessionId: () => string | undefined,
  send: (message: UiMessage) => void,
) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copy = document.createElement('button');
  copy.textContent = '复制';
  copy.type = 'button';
  copy.dataset.tooltip = entry.role === 'tool' ? '复制工具记录' : '复制原始 Markdown';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(
        entry.role === 'tool' ? JSON.stringify(entry.tool, null, 2) : entry.text,
      );
      copy.textContent = '已复制';
    } catch {
      copy.textContent = '复制失败';
    }
    setTimeout(() => {
      copy.textContent = '复制';
    }, 1500);
  };
  actions.append(copy);
  if (entry.role === 'user' || entry.role === 'assistant') {
    const type = 'branchMessage',
      label = '分支',
      tooltip = '回溯到此消息后的原生上下文；保留当时的压缩记录，不重新生成摘要';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.contextAction = type;
    button.dataset.entryId = entry.id;
    button.dataset.tooltip = tooltip;
    button.dataset.actionDescription = tooltip;
    button.onclick = () => {
      const id = sessionId();
      if (id) send({ type, id: entry.id, sessionId: id });
    };
    actions.append(button);
  }
  return actions;
}
