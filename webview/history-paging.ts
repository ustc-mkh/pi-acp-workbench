import type { ChatState, UiMessage } from '../src/shared';
export function historyPaging(messages: HTMLElement, send: (message: UiMessage) => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'load-earlier';
  button.hidden = true;
  messages.before(button);
  let sessionId: string | undefined;
  button.onclick = () => {
    if (sessionId) {
      button.disabled = true;
      send({ type: 'loadEarlier', sessionId });
    }
  };
  return (state: ChatState) => {
    sessionId = state.sessionId;
    button.hidden = !state.historyBefore || !sessionId;
    button.disabled = state.status === 'connecting';
    button.textContent = `加载更早消息（剩余 ${state.historyBefore ?? 0} 条）`;
  };
}
