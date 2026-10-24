import type * as acp from '@agentclientprotocol/sdk';

/** Text input must use elicitation: a permission choice cannot carry its value. */
export async function handleExtensionInput(
  session: {
    sessionId: string;
    // pi-acp pins SDK 0.26, whose standard form request API has this name.
    conn: {
      unstable_createElicitation(
        request: acp.CreateElicitationRequest,
      ): Promise<acp.CreateElicitationResponse>;
    };
    proc: { sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> };
  },
  ev: Record<string, unknown>,
  id: string,
) {
  const title = typeof ev.title === 'string' ? ev.title : 'Pi 提问';
  const placeholder = typeof ev.placeholder === 'string' ? ev.placeholder : '';
  const response = await session.conn.unstable_createElicitation({
    sessionId: session.sessionId,
    mode: 'form',
    message: placeholder ? `${title}\n${placeholder}` : title,
    requestedSchema: {
      type: 'object',
      properties: { value: { type: 'string', title, maxLength: 10000 } },
      required: ['value'],
    },
  });
  const content = 'content' in response ? response.content : undefined;
  const value =
    content && typeof content === 'object' ? (content as { value?: unknown }).value : undefined;
  await session.proc.sendExtensionUiResponse(
    response.action === 'accept' && typeof value === 'string' && value.length <= 10000
      ? { id, value }
      : { id, cancelled: true },
  );
}
