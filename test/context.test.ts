import { expect, it } from 'vitest';
import { checkPromptSize, contextSeed } from '../src/context';

it('preserves role-labelled text, attachment bodies and tool results without replaying reasoning or notices', () => {
  const seed = contextSeed([
    { id: '1', role: 'user', text: 'read 📎 a.ts', contextBlocks: [{ type: 'resource', resource: { uri: 'file:///a.ts', text: 'const answer = 42;' } }] },
    { id: '2', role: 'thought', text: 'private-reasoning' },
    { id: '3', role: 'notice', text: 'old-operational-notice' },
    { id: '4', role: 'tool', tool: { toolCallId: 'read', title: 'Read', status: 'completed', rawOutput: 'recorded-result' } },
    { id: '5', role: 'assistant', text: '$x^2$' },
  ], true);
  expect(seed.type).toBe('text');
  const text = JSON.stringify(seed);
  expect(text).toContain('const answer = 42;'); expect(text).toContain('recorded-result'); expect(text).toContain('$x^2$');
  expect(text).not.toContain('private-reasoning'); expect(text).not.toContain('old-operational-notice');
});
it('refuses incomplete history and missing or unsupported attachment content', () => {
  expect(() => contextSeed([], undefined)).toThrow('不完整');
  expect(() => contextSeed([{ id: '1', role: 'user', text: '📎 old.ts' }], true)).toThrow('附件正文');
  expect(() => contextSeed([{ id: '1', role: 'assistant', text: '[image]', contextBlocks: [{type:'image',mimeType:'image/png',data:'AA=='}] }], true)).toThrow('二进制');
});
it('checks the serialized UTF-8 payload including JSON escaping without truncating it', () => {
  expect(() => checkPromptSize([{ type: 'text', text: '数'.repeat(4_200_000) }])).toThrow('12 MiB');
  expect(() => checkPromptSize([{ type: 'text', text: '\n'.repeat(6_300_000) }])).toThrow('12 MiB');
});
