import { expect, it } from 'vitest';
import {
  harnessKey,
  launchSettings,
  localSessionId,
  nativeSessionId,
  snapshotHarness,
  type HarnessConfig,
} from '../src/harness';
it('uses only current external harness settings and requires explicit history metadata', () => {
  const values: Record<string, unknown> = {
    env: { PI_ONLY: 'secret' },
    'codex.env': { CODEX_ONLY: 'value' },
    'claude.args': ['--example'],
  };
  const config: HarnessConfig = {
    get: <T>(key: string, fallback: T) => (values[key] ?? fallback) as T,
  };
  expect(launchSettings(config, 'codex')).toMatchObject({
    command: 'codex-acp',
    env: { CODEX_ONLY: 'value' },
  });
  expect(launchSettings(config, 'claude')).toMatchObject({
    command: 'claude-agent-acp',
    env: {},
    args: ['--example'],
  });
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
