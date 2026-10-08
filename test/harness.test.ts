import { expect, it } from 'vitest';
import { harnessKey, localSessionId, nativeSessionId, snapshotHarness } from '../src/harness';
it('requires explicit history metadata and keeps client pointers isolated', () => {
  expect(() => snapshotHarness({})).toThrow();
  expect(snapshotHarness({ harness: 'pi' })).toBe('pi');
  expect(() => snapshotHarness({ harness: 'unknown' })).toThrow();
  expect(() => snapshotHarness({ id: 'workbench:codex:old-client' })).toThrow();
  expect(() => snapshotHarness({ id: 'workbench:codex:session', harness: 'pi' })).toThrow();
  expect(harnessKey('activeSession', 'pi')).toBe('activeSession');
  expect(harnessKey('activeSession', 'codex')).not.toBe(harnessKey('activeSession', 'claude'));
});
it('namespaces identical native IDs without changing their wire representation', () => {
  const native = 'same:id/%中文';
  const ids = ['pi', 'codex', 'claude'].map((h) =>
    localSessionId(h as 'pi' | 'codex' | 'claude', native),
  );
  expect(new Set(ids).size).toBe(3);
  expect(nativeSessionId('codex', ids[1])).toBe(native);
  expect(nativeSessionId('claude', ids[2])).toBe(native);
  expect(() => nativeSessionId('claude', ids[1])).toThrow('不属于');
  expect(() => nativeSessionId('pi', ids[1])).toThrow('保留');
  expect(() => nativeSessionId('codex', native)).toThrow('不属于');
});
