import type { ChatState } from './shared';

export interface SessionSelector {
  label: string;
  description?: string | null;
  kind: 'model' | 'thinking' | 'mode' | 'fast' | 'other';
  current: string;
  options: { id: string; name: string }[];
  change: { type: 'mode' } | { type: 'config'; id: string };
}
const thinkingName =
  /^(?:thinking(?:[ _-]level)?|thought[ _-]level|reasoning(?:[ _-](?:effort|level))?)$/i;
const thinkingPrefix = /^(?:thinking|reasoning(?: effort)?)\s*[:：]\s*/i;
const compactThinking = (name: string) => name.replace(thinkingPrefix, '').trim();

export const codexFixedConfigs: Readonly<Record<string, string>> = {
  collaboration_mode: 'default',
};
export function sessionSelectors({
  modes,
  configs,
  harness,
}: Pick<ChatState, 'modes' | 'configs' | 'harness'>): SessionSelector[] {
  const controls = (configs || []).flatMap((config) => {
    if (harness === 'codex' && Object.hasOwn(codexFixedConfigs, config.id)) return [];
    if (config.type !== 'select') return [];
    const thinking =
      config.category === 'thought_level' ||
      thinkingName.test(config.id) ||
      thinkingName.test(config.name);
    const kind: SessionSelector['kind'] =
      config.category === 'model' || config.id === 'model'
        ? 'model'
        : /^(?:fast[-_ ]mode)$/i.test(config.id) || /^(?:fast[-_ ]mode)$/i.test(config.name)
          ? 'fast'
          : thinking
            ? 'thinking'
            : config.category === 'mode'
              ? 'mode'
              : 'other';
    const options = config.options.flatMap((option) =>
      'options' in option ? option.options : [option],
    );
    return [
      {
        category: config.category,
        kind,
        label: config.name,
        description: config.description,
        current: config.currentValue,
        options: options.map((option) => ({
          id: option.value,
          name: thinking ? compactThinking(option.name) : option.name,
        })),
        change: { type: 'config' as const, id: config.id },
      },
    ];
  });
  const thinkingControl =
    controls.find((c) => c.category === 'thought_level') ||
    controls.find((c) => c.kind === 'thinking');
  const unique = controls.filter((c) => c.kind !== 'thinking' || c === thinkingControl);
  // Pi exposes model/thinking through configOptions; its parallel modes are redundant.
  const modeControls: SessionSelector[] =
    harness !== 'pi' && modes && !unique.some((c) => c.kind === 'mode')
      ? [
          {
            label: '会话模式',
            kind: 'mode',
            current: modes.currentModeId,
            options: modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name })),
            change: { type: 'mode' },
          },
        ]
      : [];
  return [...modeControls, ...unique];
}
