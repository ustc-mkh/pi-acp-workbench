import type { ChatState } from '../src/shared';

interface SessionSelector {
  label: string;
  current: string;
  options: { id: string; name: string }[];
  change: { type: 'mode' } | { type: 'config'; id: string };
}
const compactThinking = (name: string) => name.replace(/^thinking\s*[:：]\s*/i, '').trim();

export function sessionSelectors({ modes, configs }: Pick<ChatState, 'modes' | 'configs'>): SessionSelector[] {
  const controls = (configs || []).flatMap(config => {
    if (config.type !== 'select') return [];
    const thinking = config.category === 'thought_level' || /^thinking$/i.test(config.name);
    const options = config.options.flatMap(option => 'options' in option ? option.options : [option]);
    return [{
      category: config.category, thinking,
      label: config.name, current: config.currentValue,
      options: options.map(option => ({ id: option.value, name: thinking ? compactThinking(option.name) : option.name })),
      change: { type: 'config' as const, id: config.id },
    }];
  });
  // Pi exposes identical reasoning levels via legacy modes and thought_level.
  // Prefer the config API, but keep genuinely separate session modes on other agents.
  const modesCovered = controls.some(control => control.category === 'mode' || (
    control.thinking && modes && control.options.length === modes.availableModes.length &&
    modes.availableModes.every(mode => control.options.some(option => option.id === mode.id))
  ));
  const legacy: SessionSelector[] = modes && !modesCovered ? [{
    label: '思考 / 会话模式', current: modes.currentModeId,
    options: modes.availableModes.map(mode => ({ id: mode.id, name: compactThinking(mode.name) })),
    change: { type: 'mode' },
  }] : [];
  return [...legacy, ...controls];
}
