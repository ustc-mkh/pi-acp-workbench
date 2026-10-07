import { type SessionSelector } from '../src/session-settings';
export { sessionSelectors, type SessionSelector } from '../src/session-settings';

export function selectedLabel(control: SessionSelector, name: string): string {
  if (control.kind !== 'model') return name;
  const slash = name.indexOf('/');
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1).trim() : name;
}

/** Keep native option menus/keyboard support; overlay only the collapsed label. */
export function createSessionSelector(
  control: SessionSelector,
  disabled: boolean,
  change: (value: string) => void,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `selector-control selector-${control.kind}`;
  const label = document.createElement('span');
  label.className = 'selector-label';
  label.setAttribute('aria-hidden', 'true');
  const select = document.createElement('select');
  select.className = 'selector-native';
  select.setAttribute('aria-label', control.label);
  select.disabled = disabled;
  for (const option of control.options) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.name;
    select.append(element);
  }
  select.value = control.current;
  const updateLabel = () => {
    const full =
      control.options.find((option) => option.id === select.value)?.name || control.current;
    label.textContent = selectedLabel(control, full);
    wrapper.dataset.tooltip = full;
  };
  updateLabel();
  select.onchange = () => {
    updateLabel();
    change(select.value);
  };
  wrapper.append(label, select);
  return wrapper;
}
