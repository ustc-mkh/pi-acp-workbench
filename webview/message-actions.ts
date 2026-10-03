import type { Entry, UiMessage } from '../src/shared';

export function messageActions(entry: Entry, sessionId: () => string | undefined, send: (message: UiMessage) => void) {
  const actions = document.createElement('div'); actions.className = 'message-actions';
  const copy = document.createElement('button'); copy.textContent = '复制'; copy.type = 'button'; copy.dataset.tooltip = entry.role === 'tool' ? '复制工具记录' : '复制原始 Markdown';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(entry.role === 'tool' ? JSON.stringify(entry.tool, null, 2) : entry.text); copy.textContent = '已复制'; }
    catch { copy.textContent = '复制失败'; }
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  };
  actions.append(copy);
  for (const [type, label, tooltip] of [
    ['branchMessage', '分支', '保留截至此处的上下文，新建对话；必要时调用模型重建摘要'],
    ['deleteMessage', '删除', '从对话及 Agent 上下文中删除此条；必要时调用模型重建摘要'],
  ] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.contextAction = type; button.dataset.tooltip = tooltip; button.dataset.actionDescription = tooltip;
    button.onclick = () => { const id = sessionId(); if (id) send({ type, id: entry.id, sessionId: id }); };
    actions.append(button);
  }
  return actions;
}
