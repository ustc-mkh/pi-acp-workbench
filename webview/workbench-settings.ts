import type { ClientCommand, SessionView } from '../src/workbench-protocol';
import type { WorkbenchUiState } from '../src/workbench-ui';
import type { ModelControls } from './workbench-model-controls';
import type { ManagementPanel } from './workbench-management';
import type { Preferences } from './workbench-preferences';
import { element, button } from './workbench-elements';

export interface SettingsDeps {
  settings: HTMLElement;
  viewOptions: HTMLElement;
  attachImage: HTMLElement;
  modelControls: ModelControls;
  management: ManagementPanel;
  state: () => WorkbenchUiState | undefined;
  busy: boolean;
  preferences: Preferences;
  activity: HTMLButtonElement;
  mutate(command: ClientCommand): void;
  persist(): void;
  schedule(): void;
}
export function renderSettings(snapshot: SessionView, deps: SettingsDeps) {
  const {
    settings,
    viewOptions,
    attachImage,
    modelControls,
    management,
    state,
    busy,
    preferences,
  } = deps;
  const current = state();
  const definition = JSON.stringify([
    snapshot.id,
    snapshot.catalogue,
    current?.error,
    current?.view?.error,
    current?.operations.slice(-1).map((op) => [op.operation, op.status]),
    snapshot.catalogue.models.map((choice) => management.visible(choice.id, snapshot.harness)),
    busy,
    preferences.showThoughts,
    preferences.autoScroll,
    preferences.sessionRows,
    preferences.activityExpanded,
  ]);
  if (settings.dataset.definition === definition) return;
  settings.dataset.definition = definition;
  settings.replaceChildren(modelControls.root);
  const providerSelects: HTMLSelectElement[] = [];
  viewOptions.replaceChildren(attachImage);
  const discover = button(
    'Discover provider settings',
    () => deps.mutate({ method: 'discover', session: snapshot.id }),
    busy,
  );
  (snapshot.catalogue.models.length ? viewOptions : settings).append(discover);
  for (const setting of snapshot.catalogue.selects || []) {
    if (
      setting.category === 'model' ||
      setting.category === 'mode' ||
      setting.id === 'model' ||
      setting.id === 'mode'
    )
      continue;
    const select = element('select');
    select.setAttribute('aria-label', setting.name);
    select.disabled = busy;
    for (const choice of setting.choices) {
      const option = element('option', choice.name);
      option.value = choice.value;
      select.append(option);
    }
    select.value = setting.current_value;
    select.onchange = () =>
      deps.mutate({
        method: 'set_option',
        session: snapshot.id,
        id: setting.id,
        value: select.value,
      });
    select.dataset.controlKind = /fast/i.test(setting.id + ' ' + setting.name)
      ? 'fast'
      : /think|reason|effort|思考/i.test(setting.id + ' ' + setting.category + ' ' + setting.name)
        ? 'thinking'
        : 'other';
    providerSelects.push(select);
  }
  for (const key of ['model', 'mode'] as const) {
    const choices = key === 'model' ? snapshot.catalogue.models : snapshot.catalogue.modes;
    if (!choices.length || (key === 'mode' && snapshot.harness === 'Pi')) continue;
    const select = element('select');
    select.title = key === 'model' ? '模型' : '模式';
    select.setAttribute('aria-label', key);
    select.disabled = busy;
    const unknown = element('option', key === 'model' ? '选择模型' : '选择模式');
    unknown.value = '';
    select.append(unknown);
    for (const choice of choices) {
      if (
        key === 'model' &&
        choice.id !== snapshot.catalogue.current_model &&
        !management.visible(choice.id, snapshot.harness)
      )
        continue;
      const option = element('option', choice.name);
      option.value = choice.id;
      select.append(option);
    }
    select.value =
      (key === 'model' ? snapshot.catalogue.current_model : snapshot.catalogue.current_mode) || '';
    select.addEventListener('change', () => {
      const value = choices.find((choice) => choice.id === select.value);
      if (!value) return;
      deps.mutate(
        key === 'model'
          ? {
              method: 'set_model',
              session: snapshot.id,
              model: value.id as NonNullable<SessionView['config']['model']>,
            }
          : {
              method: 'set_mode',
              session: snapshot.id,
              mode: value.id as NonNullable<SessionView['config']['mode']>,
            },
      );
    });
    providerSelects.push(select);
  }
  const last = current?.operations.at(-1);
  const failure =
    last &&
    ['set_option', 'set_model', 'set_mode'].includes(last.method) &&
    ['failed', 'uncertain'].includes(last.status)
      ? `${last.operation}:${last.status}`
      : !current?.operations.length
        ? current?.error || current?.view?.error
        : undefined;
  modelControls.update(
    snapshot.id + ':' + snapshot.catalogue.current_model,
    providerSelects,
    failure,
  );
  const processLabel = element('label', '显示执行过程');
  const processToggle = element('input');
  processToggle.type = 'checkbox';
  processToggle.checked = preferences.activityExpanded;
  processToggle.onchange = () => deps.activity.click();
  processLabel.prepend(processToggle);
  viewOptions.append(processLabel);
  const thoughtLabel = element('label', '显示思考过程');
  const showThoughts = element('input');
  showThoughts.type = 'checkbox';
  showThoughts.setAttribute('aria-label', '显示思考过程');
  showThoughts.checked = preferences.showThoughts;
  showThoughts.addEventListener('change', () => {
    preferences.showThoughts = showThoughts.checked;
    deps.persist();
    deps.schedule();
  });
  thoughtLabel.prepend(showThoughts);
  viewOptions.append(thoughtLabel);
  const autoScroll = element('input');
  autoScroll.type = 'checkbox';
  autoScroll.checked = preferences.autoScroll;
  autoScroll.onchange = () => {
    preferences.autoScroll = autoScroll.checked;
    deps.persist();
  };
  const scrollLabel = element('label', '跟随最新输出');
  scrollLabel.prepend(autoScroll);
  const rows = element('select');
  rows.setAttribute('aria-label', 'Session list rows');
  for (const i of [4, 10, 16]) {
    const option = element('option', `${i} 条会话高度`);
    option.value = String(i);
    rows.append(option);
  }
  rows.value = String(preferences.sessionRows);
  rows.onchange = () => {
    preferences.sessionRows = Number(rows.value);
    deps.persist();
    deps.schedule();
  };
  viewOptions.append(scrollLabel, rows);
  let confirmRemove = false;
  const remove = button(
    'Remove session',
    () => {
      if (!confirmRemove) {
        confirmRemove = true;
        remove.textContent = '确认删除会话（保留原生数据）';
        return;
      }
      deps.mutate({ method: 'remove', session: snapshot.id });
    },
    !current?.trusted,
  );
  viewOptions.append(remove);
  if (snapshot.harness === 'Pi')
    viewOptions.append(
      button('Stop Pi background worker', () =>
        deps.mutate({ method: 'cancel', session: snapshot.id }),
      ),
    );
}
