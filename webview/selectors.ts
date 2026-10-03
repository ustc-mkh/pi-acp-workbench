import type { ChatState } from '../src/shared';

export interface SessionSelector {
  label: string;
  kind: 'model' | 'thinking' | 'mode' | 'other';
  current: string;
  options: { id: string; name: string }[];
  change: { type: 'mode' } | { type: 'config'; id: string };
}
const thinkingName = /^(?:thinking(?:[ _-]level)?|thought[ _-]level|reasoning(?:[ _-](?:effort|level))?)$/i;
const thinkingPrefix = /^(?:thinking|reasoning(?: effort)?)\s*[:：]\s*/i;
const levelName = /^(?:off|none|minimal|low|medium|high|xhigh|max|enabled|disabled|on)$/i;
const compactThinking = (name: string) => name.replace(thinkingPrefix, '').trim();

export function sessionSelectors({ modes, configs }: Pick<ChatState, 'modes' | 'configs'>): SessionSelector[] {
  const controls = (configs || []).flatMap(config => {
    if (config.type !== 'select') return [];
    const thinking = config.category === 'thought_level' || thinkingName.test(config.id) || thinkingName.test(config.name);
    const kind: SessionSelector['kind'] = config.category === 'model' || config.id === 'model' ? 'model' : thinking ? 'thinking' : config.category === 'mode' ? 'mode' : 'other';
    const options = config.options.flatMap(option => 'options' in option ? option.options : [option]);
    return [{
      category: config.category, kind,
      label: config.name, current: config.currentValue,
      options: options.map(option => ({ id: option.value, name: thinking ? compactThinking(option.name) : option.name })),
      change: { type: 'config' as const, id: config.id },
    }];
  });
  // Model switches can change supported levels while legacy modes remain stale.
  // Recognize the purpose of the control instead of requiring identical option sets.
  const thinkingControl = controls.find(c => c.category === 'thought_level') || controls.find(c => c.kind === 'thinking');
  const unique = controls.filter(c => c.kind !== 'thinking' || c === thinkingControl);
  const thinkingModes = !!modes?.availableModes.length && modes.availableModes.every(mode =>
    thinkingPrefix.test(mode.name) || levelName.test(mode.id) || levelName.test(mode.name));
  const sameLevels = !!modes && !!thinkingControl && modes.availableModes.length === thinkingControl.options.length &&
    modes.availableModes.every(mode => thinkingControl.options.some(option => option.id === mode.id));
  const modesCovered = unique.some(c => c.kind === 'mode') || (!!thinkingControl && (thinkingModes || sameLevels));
  const legacy: SessionSelector[] = modes && !modesCovered ? [{
    label: thinkingModes ? 'Thinking' : '会话模式', kind: thinkingModes ? 'thinking' : 'mode', current: modes.currentModeId,
    options: modes.availableModes.map(mode => ({ id: mode.id, name: compactThinking(mode.name) })),
    change: { type: 'mode' },
  }] : [];
  return [...legacy, ...unique];
}

export function selectedLabel(control: SessionSelector, name: string): string {
  if (control.kind !== 'model') return name;
  const slash = name.indexOf('/');
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1).trim() : name;
}

/** Keep native option menus/keyboard support; overlay only the collapsed label. */
export function createSessionSelector(control: SessionSelector, disabled: boolean, change: (value: string) => void): HTMLElement {
  const wrapper = document.createElement('div'); wrapper.className = `selector-control selector-${control.kind}`;
  const label = document.createElement('span'); label.className = 'selector-label'; label.setAttribute('aria-hidden', 'true');
  const select = document.createElement('select'); select.className = 'selector-native'; select.setAttribute('aria-label', control.label); select.disabled = disabled;
  for (const option of control.options) {
    const element = document.createElement('option'); element.value = option.id; element.textContent = option.name; select.append(element);
  }
  select.value = control.current;
  const updateLabel = () => {
    const full = control.options.find(option => option.id === select.value)?.name || control.current;
    label.textContent = selectedLabel(control, full); wrapper.dataset.tooltip = full;
  };
  updateLabel(); select.onchange = () => { updateLabel(); change(select.value); };
  wrapper.append(label, select); return wrapper;
}
