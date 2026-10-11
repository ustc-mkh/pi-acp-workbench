import { expect, it } from 'vitest';
import { StateInbox } from '../webview/state-inbox';
import { initialState } from '../src/state';
it('rejects missing baselines/gaps and accepts a fresh snapshot after resynchronization', () => {
  const inbox = new StateInbox();
  const patch = {
    type: 'statePatch' as const,
    revision: 2,
    fields: { error: 'test' },
    unset: [],
    entries: [],
  };
  expect(inbox.receive(patch)).toBe('resync');
  const state = { ...initialState(), sessionId: 'one' };
  expect(inbox.receive({ type: 'state', state, revision: 1 })).toMatchObject({ switched: true });
  expect(inbox.receive(patch)).toMatchObject({ state: { error: 'test' }, switched: false });
  expect(inbox.receive({ ...patch, revision: 4 })).toBe('resync');
  expect(
    inbox.receive({ type: 'state', state: { ...state, sessionId: 'two' }, revision: 1 }),
  ).toMatchObject({ switched: true, state: { sessionId: 'two' } });
});
