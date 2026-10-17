import type { ChatState, UiMessage } from '../src/shared';

/** Render RPC dialogs without treating questions as dangerous-tool approvals. */
export function extensionQuestion(
  item: ChatState['permissions'][number],
  send: (message: UiMessage) => void,
): HTMLElement | undefined {
  const tool = item.request.toolCall;
  const raw = tool.rawInput as Record<string, unknown> | undefined;
  if (
    !tool.toolCallId?.startsWith('pi-ui-') ||
    !raw ||
    !['select', 'confirm', 'input', 'editor'].includes(String(raw.method))
  )
    return;
  const card = document.createElement('section');
  card.className = 'permission-card extension-question';
  const heading = document.createElement('strong');
  heading.textContent = 'Pi · 等待你的回答';
  const title = document.createElement('div');
  title.className = 'question-title';
  title.textContent = tool.title || '请选择';
  card.append(heading, title);
  if (typeof raw.message === 'string') {
    const message = document.createElement('p');
    message.textContent = raw.message;
    card.append(message);
  }
  const input = raw.method === 'input' || raw.method === 'editor';
  let editor: HTMLTextAreaElement | undefined;
  if (input && item.request._meta?.['pi-workbench-input'] === true) {
    editor = document.createElement('textarea');
    editor.rows = raw.method === 'editor' ? 6 : 3;
    editor.maxLength = 10000;
    editor.setAttribute('aria-label', '回答');
    editor.placeholder = typeof raw.placeholder === 'string' ? raw.placeholder : '输入你的回答';
    editor.value = typeof raw.prefill === 'string' ? raw.prefill : '';
    card.append(editor);
  }
  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  const answer = (label: string, optionId?: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => {
      send({
        type: 'permission',
        id: item.id,
        optionId,
        ...(optionId && editor ? { value: editor.value } : {}),
      });
      for (const b of card.querySelectorAll('button')) b.disabled = true;
    };
    actions.append(button);
  };
  for (const option of item.request.options) answer(option.name, option.optionId);
  answer('取消');
  card.append(actions);
  return card;
}
