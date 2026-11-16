import { expect, it } from 'vitest';
import { uiMessage } from '../src/workbench-ui';
import { operationId } from '../src/workbench-protocol';

it('rejects malformed diff and undo envelopes before browser dispatch', () => {
  for (const message of [
    { type: 'undo_result', session: 's', turn: 't', report: { files: null } },
    { type: 'turn_diff', session: 's', turn: 't', diff: { files: [] } },
    {
      type: 'turn_diff_content',
      session: 's',
      turn: 't',
      file: -1,
      after: false,
      offset: 0,
      bytes: '',
      total_bytes: 0,
    },
    { type: 'turn_diff_error', session: 's', turn: 't', error: 'failed', command: 'execute' },
  ])
    expect(() => uiMessage.parse(message)).toThrow();
});
it('preserves acknowledgement identity and rejects unsafe draft generations', () => {
  const accepted = {
    type: 'prompt_accepted',
    session: 's',
    operation: operationId.parse('op'),
    generation: 3,
    prompt: { parts: [{ type: 'text', text: 'hello' }] },
  };
  expect(uiMessage.parse(accepted)).toMatchObject(accepted);
  for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => uiMessage.parse({ ...accepted, generation })).toThrow();
});
it('validates editor selection and image errors through the same message contract', () => {
  const selection = {
    type: 'selection_context',
    file: { id: 'f', name: 'file.ts', text: 'const n = 1;' },
  };
  expect(uiMessage.parse(selection)).toEqual(selection);
  expect(() =>
    uiMessage.parse({
      type: 'image_error',
      session: 's',
      image: 'i',
      request_id: '1',
      error: 'failed',
    }),
  ).toThrow();
});
