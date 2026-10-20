import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextAttachment } from '../src/workbench-attachments';
import { composePrompt, MAX_ATTACHMENT_BYTES } from '../src/workbench-input';
import { AttachmentDrafts } from '../webview/workbench-attachment-drafts';
import { Preferences } from '../webview/workbench-preferences';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('reads only explicitly selected bounded UTF-8 files inside the canonical workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-attachments-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const source = join(workspace, 'source.ts');
  await writeFile(source, '你好 🌏');
  expect(await readTextAttachment(source, workspace)).toEqual({
    name: 'source.ts',
    text: '你好 🌏',
  });
  const outside = join(root, 'secret');
  await writeFile(outside, 'secret');
  await symlink(outside, join(workspace, 'escape'));
  await expect(readTextAttachment(join(workspace, 'escape'), workspace)).rejects.toThrow('inside');
  await expect(readTextAttachment(outside, workspace)).rejects.toThrow('inside');
  await link(source, join(workspace, 'hard'));
  await expect(readTextAttachment(source, workspace)).rejects.toThrow('hard links');
  await expect(readTextAttachment(workspace, workspace)).rejects.toThrow();
});
it('rejects oversized, invalid UTF-8 and binary files without partial attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-attachment-bounds-'));
  roots.push(root);
  for (const [name, data] of [
    ['large', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)],
    ['invalid', Buffer.from([0xff])],
    ['binary', Buffer.from('a\0b')],
  ] as const) {
    const path = join(root, name);
    await writeFile(path, data);
    await expect(readTextAttachment(path, root)).rejects.toThrow();
  }
});
it('composes explicit context within Unicode budgets and preserves attachments across reload', () => {
  const file = { id: 'f', name: 'source.ts', text: '你好' };
  expect(composePrompt('Review', [file])).toEqual({
    parts: [
      { type: 'text', text: 'Review' },
      { type: 'context', ...file },
    ],
  });
  expect(() => composePrompt('x'.repeat(100001), [])).toThrow('budget');
  expect(() =>
    composePrompt(
      '',
      Array.from({ length: 9 }, () => file),
    ),
  ).toThrow('Too many');
  const drafts = new AttachmentDrafts();
  drafts.set('a', [file]);
  const restored = new AttachmentDrafts(drafts.snapshot());
  expect(restored.get('a')).toEqual([file]);
  expect(restored.get('b')).toEqual([]);
  const copy = restored.get('a');
  copy[0].text = 'changed';
  expect(restored.get('a')[0].text).toBe('你好');
  expect(() => restored.set('a', [file, file])).toThrow();
  expect(() => restored.set('a', [{ ...file, text: 'x'.repeat(65537) }])).toThrow();
  expect(restored.get('a')).toEqual([file]);
  restored.set('a', []);
  expect(restored.get('a')).toEqual([]);
});
it('restores only validated bounded display preferences', () => {
  const preferences = new Preferences();
  preferences.showThoughts = false;
  for (let i = 0; i < 300; i++) preferences.setOpen(`turn-${i}`, true);
  expect(preferences.snapshot().preferences.disclosures).toHaveLength(256);
  const restored = new Preferences(preferences.snapshot());
  expect(restored.showThoughts).toBe(false);
  expect(restored.open('turn-299', false)).toBe(true);
  expect(restored.open('turn-0', false)).toBe(false);
  const malformed = new Preferences({
    preferences: {
      showThoughts: 'false',
      disclosures: [
        [{}, true],
        ['valid', false],
      ],
    },
  });
  expect(malformed.showThoughts).toBe(true);
  expect(malformed.open('valid', true)).toBe(false);
});
