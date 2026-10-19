import { expect, it } from 'vitest';
import { Drafts, MAX_TOTAL_DRAFT_CHARS } from '../webview/workbench-drafts';

it('restores only bounded text preferences, not executable commands or domain state', () => {
  const drafts = new Drafts({ drafts: [['session', 'unfinished']], command: { method: 'prompt' } });
  expect(drafts.get('session')).toBe('unfinished');
  expect(drafts.snapshot()).toEqual({ drafts: [['session', 'unfinished']] });
  drafts.set('session', '');
  expect(new Drafts(drafts.snapshot()).get('session')).toBe('');
  expect(
    new Drafts({
      drafts: [
        ['bad', 5],
        ['valid', 'yes'],
      ],
    }).get('valid'),
  ).toBe('yes');
  expect(new Drafts({ drafts: Array(17).fill(['session', 'x']) }).snapshot().drafts).toEqual([]);
});

it('enforces per-draft, count and aggregate budgets with oldest-first eviction', () => {
  const drafts = new Drafts();
  drafts.set('oversized', 'x'.repeat(200001));
  expect(drafts.get('oversized')).toBe('');
  for (let i = 0; i < 20; i++) drafts.set(String(i), 'x'.repeat(40000));
  const saved = drafts.snapshot();
  expect(saved.drafts.length).toBeLessThanOrEqual(16);
  expect(saved.drafts.reduce((sum, [, text]) => sum + text.length, 0)).toBeLessThanOrEqual(
    MAX_TOTAL_DRAFT_CHARS,
  );
  expect(drafts.get('0')).toBe('');
  expect(new Drafts(saved).get('19')).toHaveLength(40000);
});
