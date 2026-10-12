import { expect, it } from 'vitest';
import { mergeCatalogue } from '../src/catalogue';

it.each(['cold', 'live'] as const)('%s catalogue omissions preserve known values', (phase) => {
  const previous = [{ id: 'model' }];
  const next = [{ id: 'thinking' }];
  expect(mergeCatalogue(previous, undefined, phase)).toBe(previous);
  expect(mergeCatalogue(previous, null, phase)).toBe(previous);
  expect(mergeCatalogue(previous, next, phase)).toBe(next);
  expect(mergeCatalogue(undefined, undefined, phase)).toBeUndefined();
});

it('falls back on empty cold catalogues but accepts explicit live clears', () => {
  const previous = [{ id: 'model' }];
  const empty: typeof previous = [];
  expect(mergeCatalogue(previous, empty, 'cold')).toBe(previous);
  expect(mergeCatalogue(undefined, empty, 'cold')).toBeUndefined();
  expect(mergeCatalogue(previous, empty)).toBe(empty);
  const modes = { currentModeId: 'high', availableModes: [] };
  expect(mergeCatalogue<object>(modes, {}, 'cold')).toBe(modes);
  expect(mergeCatalogue<object>(modes, {})).toEqual({});
});
