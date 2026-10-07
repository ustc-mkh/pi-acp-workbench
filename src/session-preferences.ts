import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicJson } from './atomic-json';
import { isHarnessId, type HarnessId } from './harness';
import { sessionPreferences, type SessionPreference } from './session-settings';
import type { ChatState } from './shared';

export function modelPreferences(state: Pick<ChatState, 'configs' | 'modes' | 'harness'>) {
  return sessionPreferences(state).filter((p) => p.kind === 'model' || p.kind === 'thinking');
}

/** Account-wide model/thinking pairs. Permission modes are deliberately not inherited. */
export class SessionPreferences {
  constructor(private directory = join(homedir(), '.pi', 'pi-acp-workbench', 'preferences')) {}
  private file(harness: HarnessId) {
    if (!isHarnessId(harness)) throw new Error('未知 harness。');
    return join(this.directory, `${harness}.json`);
  }
  async read(harness: HarnessId): Promise<SessionPreference[]> {
    let text: string;
    try {
      text = await readFile(this.file(harness), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const data = JSON.parse(text);
      if (
        data.version !== 1 ||
        !Array.isArray(data.preferences) ||
        data.preferences.length > 2 ||
        !data.preferences.every(
          (p: SessionPreference) =>
            p &&
            ['model', 'thinking'].includes(p.kind) &&
            typeof p.value === 'string' &&
            p.value.length > 0 &&
            p.value.length <= 10000,
        ) ||
        new Set(data.preferences.map((p: SessionPreference) => p.kind)).size !==
          data.preferences.length
      )
        throw new Error();
      return data.preferences;
    } catch {
      throw new Error(`模型偏好格式不受支持或已损坏，原文件未修改：${this.file(harness)}`);
    }
  }
  async save(harness: HarnessId, state: Pick<ChatState, 'configs' | 'modes' | 'harness'>) {
    const preferences = modelPreferences(state);
    if (!preferences.length) return;
    await this.read(harness); // Never silently replace corrupt or incompatible data.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // One atomic pair per harness: concurrent writers cannot mix model and thinking.
    await writeAtomicJson(this.file(harness), { version: 1, preferences }, true);
  }
}
