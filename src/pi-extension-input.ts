import type * as acp from '@agentclientprotocol/sdk';

/** Private ACP metadata; option IDs remain standard, fixed permission choices. */
export const INPUT_META = 'pi-workbench-input';
export async function handleExtensionInput(
  session: {
    sessionId: string;
    conn: Pick<acp.AgentSideConnection, 'requestPermission'>;
    proc: { sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> };
  },
  ev: Record<string, unknown>,
  id: string,
) {
  const response = await session.conn.requestPermission({
    sessionId: session.sessionId,
    _meta: { [INPUT_META]: true },
    toolCall: {
      toolCallId: `pi-ui-${id}`,
      title: typeof ev.title === 'string' ? ev.title : 'Pi 提问',
      kind: 'other',
      status: 'pending',
      rawInput: {
        method: ev.method,
        placeholder: ev.placeholder,
        prefill: ev.prefill,
      },
    },
    options: [{ optionId: 'submit', name: '提交回答', kind: 'allow_once' }],
  });
  const data = response._meta?.[INPUT_META] as { value?: unknown } | undefined;
  await session.proc.sendExtensionUiResponse(
    response.outcome.outcome === 'selected' &&
      response.outcome.optionId === 'submit' &&
      typeof data?.value === 'string' &&
      data.value.length <= 10000
      ? { id, value: data.value }
      : { id, cancelled: true },
  );
}
