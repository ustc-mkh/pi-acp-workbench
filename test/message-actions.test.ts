// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { messageActions } from '../webview/message-actions';
it('offers the same actions for user and assistant messages and binds edits to the current session', async () => {
  const send = vi.fn(),
    writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  for (const role of ['user', 'assistant'] as const) {
    const actions = messageActions({ id: role, role, text: '**Markdown**' }, () => 'session', send);
    const buttons = actions.querySelectorAll('button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['复制', '分支']);
    buttons[0].click();
    buttons[1].click();
    expect(writeText).toHaveBeenCalledWith('**Markdown**');
    expect(send).toHaveBeenCalledWith({ type: 'branchMessage', id: role, sessionId: 'session' });
    expect(buttons[1].dataset.entryId).toBe(role);
    buttons[1].disabled = true;
    send.mockClear();
    buttons[1].click();
    expect(send).not.toHaveBeenCalled();
  }
});
