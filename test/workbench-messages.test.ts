import { expect, it } from 'vitest';
import { entryHeader, sessionId } from '../src/workbench-protocol';
import {
  MessageProjection,
  continuesMessage,
  externalDestination,
  projectMessages,
} from '../src/workbench-messages';
import { exportMarkdown } from '../src/workbench-export';
import { copyLogicalMessage } from '../src/workbench-copy';
import type { WorkbenchClient } from '../src/workbench-client';

const row = (seq: number, text: string) =>
  entryHeader.parse({
    seq,
    id: `e${seq}`,
    turn: 'turn',
    role: 'Agent',
    message: 'provider-message',
    text: { Inline: { text } },
    image: null,
  });
it('groups only adjacent identified fragments, without modifying committed rows', () => {
  const rows = [row(1, '```ts\n'), row(2, 'const x = 1;\n```')];
  const before = structuredClone(rows);
  expect(projectMessages(rows)).toHaveLength(1);
  for (const change of [
    { seq: 3 },
    { turn: 'another' },
    { role: 'Thought' },
    { message: null },
    { message: 'other' },
  ])
    expect(continuesMessage(rows[0], { ...rows[1], ...change } as never)).toBe(false);
  expect(rows).toEqual(before);
  const projection = new MessageProjection();
  const key = projection.update(rows.slice(1))[0].key;
  expect(projection.update(rows)[0].key).toBe(key);
  expect(projection.update([...rows, row(3, '\nDone')])[0].inlineText).toBe(
    '```ts\nconst x = 1;\n```\nDone',
  );
});
it('copy/export preserve complete Markdown across cold page boundaries', async () => {
  const session = sessionId.parse('session');
  const rows = [row(1, '```ts\n'), row(2, 'const x = 1;\n'), row(3, '```')];
  const client = {
    call: async (command: any) => {
      expect(command.method).toBe('history');
      return command.cursor
        ? { entries: rows.slice(0, 1), next_cursor: null }
        : {
            entries: rows.slice(1),
            next_cursor: { version: 3, session, max_entry_seq: 3, before_seq: 2 },
          };
    },
  } as unknown as Pick<WorkbenchClient, 'call'>;
  const expected = '```ts\nconst x = 1;\n```';
  expect(await copyLogicalMessage(client, session, rows[1].id, () => {})).toBe(expected);
  let output = '';
  for await (const chunk of exportMarkdown(client, session)) output += chunk;
  expect(output).toContain(expected);
  expect(output.match(/^## /gm)).toHaveLength(1);
});
it('normalizes IDNs and rejects credentials, local files, command/script and malformed URLs', () => {
  expect(externalDestination('https://例子.测试/path')).toBe(
    'https://xn--fsqu00a.xn--0zwm56d/path',
  );
  expect(externalDestination('mailto:person@example.com')).toBe('mailto:person@example.com');
  for (const url of [
    'https://user:secret@example.com',
    'command:foo',
    'javascript:alert(1)',
    'file:///tmp/private',
    '/etc/passwd',
    'https://example.com\n',
  ])
    expect(() => externalDestination(url)).toThrow();
});
