import { homedir } from 'node:os';
import { join } from 'node:path';

/** Machine-account preferences, independent of VS Code profiles/workspaces.
 * Deliberately independent of cwd and PI_CODING_AGENT_DIR as well.
 */
export function localPreferencesPath(file: string) {
  return join(homedir(), '.pi', 'pi-acp-workbench', 'preferences', file);
}
