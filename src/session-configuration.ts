import type * as acp from '@agentclientprotocol/sdk';
import type { Agent as AgentProcess } from './remote-agent';
import { sessionSelectors, type SessionPreference, type SessionSelector } from './session-settings';

/** Validate against the latest catalogue; model changes can replace other options. */
async function applySelection(
  agent: AgentProcess,
  session: acp.NewSessionResponse,
  change: SessionSelector['change'],
  value: string,
): Promise<boolean> {
  if (change.type === 'config') {
    const config = session.configOptions?.find((c) => c.id === change.id);
    if (config?.currentValue === value) return true;
    if (
      config?.type !== 'select' ||
      !config.options
        .flatMap((o) => ('options' in o ? o.options : [o]))
        .some((o) => o.value === value)
    )
      return false;
    const response = await agent.withTimeout(
      agent.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: change.id,
        value,
      }),
    );
    session.configOptions = response.configOptions;
  } else {
    if (session.modes?.currentModeId === value) return true;
    if (!session.modes?.availableModes.some((m) => m.id === value)) return false;
    await agent.withTimeout(
      agent.request('session/set_mode', { sessionId: session.sessionId, modeId: value }),
    );
    session.modes = { ...session.modes, currentModeId: value };
  }
  return true;
}

/** New conversations may use current defaults when a saved preference is unavailable. */
export async function applyPreferences(
  agent: AgentProcess,
  session: acp.NewSessionResponse,
  preferences: SessionPreference[],
) {
  const unavailable: string[] = [];
  const ordered = [...preferences].sort(
    (a, b) => Number(b.kind === 'model') - Number(a.kind === 'model'),
  );
  for (const preference of ordered) {
    const control = sessionSelectors({
      harness: agent.harness,
      configs: session.configOptions || undefined,
      modes: session.modes || undefined,
    }).find((c) => c.kind === preference.kind);
    if (!control || !(await applySelection(agent, session, control.change, preference.value))) {
      unavailable.push(`${preference.kind}: ${preference.value}`);
    }
  }
  return unavailable.length
    ? `上次的设置当前不可用（${unavailable.join('、')}），请检查本次模型与思考选项。`
    : undefined;
}
