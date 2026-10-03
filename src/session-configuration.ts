import type * as acp from '@agentclientprotocol/sdk';
import type { AgentProcess } from './agent';
import type { Snapshot } from './shared';
import { sessionSelectors, type SessionPreference, type SessionSelector } from './session-settings';

/** Validate against the latest catalogue; model changes can replace other options. */
async function applySelection(agent: AgentProcess, session: acp.NewSessionResponse,
  change: SessionSelector['change'], value: string): Promise<boolean> {
  if (change.type === 'config') {
    const config = session.configOptions?.find(c => c.id === change.id);
    if (config?.currentValue === value) return true;
    if (config?.type !== 'select' || !config.options.flatMap(o => 'options' in o ? o.options : [o]).some(o => o.value === value)) return false;
    const response = await agent.withTimeout(agent.request('session/set_config_option', {
      sessionId: session.sessionId, configId: change.id, value,
    }));
    session.configOptions = response.configOptions;
  } else {
    if (session.modes?.currentModeId === value) return true;
    if (!session.modes?.availableModes.some(m => m.id === value)) return false;
    await agent.withTimeout(agent.request('session/set_mode', {sessionId:session.sessionId, modeId:value}));
    session.modes = {...session.modes, currentModeId:value};
  }
  return true;
}

/** New conversations may use current defaults when a saved preference is unavailable. */
export async function applyPreferences(agent: AgentProcess, session: acp.NewSessionResponse, preferences: SessionPreference[]) {
  const unavailable: string[] = [];
  const ordered = [...preferences].sort((a,b) => Number(b.kind === 'model') - Number(a.kind === 'model'));
  for (const preference of ordered) {
    const control = sessionSelectors({harness:agent.harness, configs:session.configOptions || undefined, modes:session.modes || undefined})
      .find(c => c.kind === preference.kind);
    if (!control || !await applySelection(agent, session, control.change, preference.value)) {
      unavailable.push(`${preference.kind}: ${preference.value}`);
    }
  }
  return unavailable.length ? `上次的设置当前不可用（${unavailable.join('、')}），请检查本次模型与思考选项。` : undefined;
}

/** Replacing an existing session requires preserving every saved setting. */
export async function restoreSettings(agent: AgentProcess, session: acp.NewSessionResponse, previous: Pick<Snapshot, 'configs' | 'modes'>) {
  const isModel = (c: acp.SessionConfigOption) => c.category === 'model' || c.id === 'model';
  const configs = [...previous.configs || []].sort((a,b) => Number(isModel(b)) - Number(isModel(a)));
  for (const config of configs) {
    if (session.configOptions?.find(c => c.id === config.id)?.currentValue === config.currentValue) continue;
    if (config.type !== 'select' || !await applySelection(agent, session, {type:'config', id:config.id}, config.currentValue)) {
      throw new Error(`无法在新会话中保留设置「${config.name}」，上下文未修改。`);
    }
  }
  const mode = previous.modes?.currentModeId;
  if (mode && !await applySelection(agent, session, {type:'mode'}, mode)) {
    throw new Error('无法保留当前会话模式，上下文未修改。');
  }
}
