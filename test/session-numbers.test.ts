import { expect, it } from 'vitest';
import {
  allocateSessionNumber,
  sessionLabel,
  type SessionNumberIndex,
} from '../src/session-numbers';
import type { Snapshot } from '../src/shared';
const snapshot = (id: string, updated = 1): Snapshot => ({
  id,
  cwd: '/project',
  title: 'same title',
  updated,
  entries: [],
});
it('gives branches distinct numbers and preserves logical replacements', () => {
  const index: SessionNumberIndex = {
    sessions: [{ ...snapshot('parent'), conversationId: 'logical', sessionNumber: 1 }],
    nextSessionNumber: 2,
  };
  expect(
    allocateSessionNumber(index, { ...snapshot('replacement'), conversationId: 'logical' }),
  ).toBe(1);
  expect(allocateSessionNumber(index, snapshot('branch'))).toBe(2);
  index.sessions = [];
  expect(allocateSessionNumber(index, snapshot('after-clear'))).toBe(3);
});

it('formats stable numbers and labels unsaved sessions by ID', () => {
  expect(sessionLabel(2)).toBe('#002');
  expect(sessionLabel(undefined, 'new')).toBe('ID new');
});
