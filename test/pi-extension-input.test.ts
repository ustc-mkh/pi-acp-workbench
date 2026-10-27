import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { handleExtensionInput } from '../src/pi-extension-input';

function session(response: acp.CreateElicitationResponse) {
  return {
    sessionId: 'native-pi-input',
    conn: {
      unstable_createElicitation: vi.fn(async (_request: acp.CreateElicitationRequest) => response),
    },
    proc: { sendExtensionUiResponse: vi.fn(async (_value: Record<string, unknown>) => {}) },
  };
}
it('Pi extension input uses a typed elicitation and returns the exact submitted value', async () => {
  const s = session({ action: 'accept', content: { value: 'P6_ALLOW 中文' } });
  await handleExtensionInput(
    s,
    { method: 'input', title: 'Consent', placeholder: 'Type consent' },
    'ui-1',
  );
  expect(s.conn.unstable_createElicitation).toHaveBeenCalledWith({
    sessionId: 'native-pi-input',
    mode: 'form',
    message: 'Consent\nType consent',
    _meta: {
      'pi-workbench-question': {
        method: 'input',
        title: 'Consent',
        message: '',
        placeholder: 'Type consent',
        prefill: '',
      },
    },
    requestedSchema: {
      type: 'object',
      properties: { value: { type: 'string', title: 'Consent', maxLength: 10000 } },
      required: [],
    },
  });
  expect(s.proc.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({
    id: 'ui-1',
    value: 'P6_ALLOW 中文',
  });
});
for (const action of ['decline', 'cancel'] as const) {
  it(`${action} never fabricates a submitted input`, async () => {
    const s = session({ action });
    await handleExtensionInput(s, { method: 'editor' }, 'ui-2');
    expect(s.proc.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({
      id: 'ui-2',
      cancelled: true,
    });
  });
}
it('invalid or oversized accepted values fail closed', async () => {
  for (const value of [false, 'x'.repeat(10001)]) {
    const s = session({ action: 'accept', content: { value } });
    await handleExtensionInput(s, { method: 'input' }, 'ui-3');
    expect(s.proc.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({
      id: 'ui-3',
      cancelled: true,
    });
  }
});
it('an empty editor result is an explicit accepted value', async () => {
  const s = session({ action: 'accept', content: { value: '' } });
  await handleExtensionInput(s, { method: 'editor' }, 'ui-4');
  expect(s.proc.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({ id: 'ui-4', value: '' });
});
it('a failed client request cannot send a success response to Pi', async () => {
  const s = session({ action: 'cancel' });
  s.conn.unstable_createElicitation.mockRejectedValueOnce(new Error('client closed'));
  await expect(handleExtensionInput(s, { method: 'input' }, 'ui-5')).rejects.toThrow(
    'client closed',
  );
  expect(s.proc.sendExtensionUiResponse).not.toHaveBeenCalled();
});

it('the pinned pi-acp SDK runtime exposes the actual elicitation method used by the bridge', async () => {
  const root = createRequire(import.meta.url);
  const upstream = createRequire(root.resolve('pi-acp'));
  const runtime = await import(pathToFileURL(upstream.resolve('@agentclientprotocol/sdk')).href);
  expect(typeof runtime.AgentSideConnection.prototype.unstable_createElicitation).toBe('function');
});

it('preserves editor presentation, prompt and prefill without mixing it into the answer', async () => {
  const s = session({ action: 'accept', content: { value: 'edited\n中文' } });
  await handleExtensionInput(
    s,
    {
      method: 'editor',
      title: 'Edit plan',
      message: 'Review before continuing',
      placeholder: 'Your plan',
      prefill: 'original\n计划',
    },
    'editor',
  );
  expect(s.conn.unstable_createElicitation.mock.calls[0][0]).toMatchObject({
    _meta: {
      'pi-workbench-question': {
        method: 'editor',
        title: 'Edit plan',
        message: 'Review before continuing',
        placeholder: 'Your plan',
        prefill: 'original\n计划',
      },
    },
  });
  expect(s.proc.sendExtensionUiResponse).toHaveBeenCalledExactlyOnceWith({
    id: 'editor',
    value: 'edited\n中文',
  });
});
