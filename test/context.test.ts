import { expect, it } from 'vitest';
import { checkPromptSize } from '../src/context';
it('checks the serialized UTF-8 payload including JSON escaping without truncating it', () => {
  expect(() => checkPromptSize([{ type: 'text', text: '数'.repeat(4_200_000) }])).toThrow('12 MiB');
  expect(() => checkPromptSize([{ type: 'text', text: '\n'.repeat(6_300_000) }])).toThrow('12 MiB');
});
