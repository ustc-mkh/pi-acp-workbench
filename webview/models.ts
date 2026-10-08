import type { ChatState, UiMessage } from '../src/shared';
import { sessionSelectors } from './selectors';

/** Full searchable catalogue; selections affect the compact model picker only. */
export class ModelsPage {
  private state?: ChatState;
  private signature = '';
  private search: HTMLInputElement;
  private list: HTMLElement;
  private count: HTMLElement;
  constructor(
    private root: HTMLElement,
    private send: (message: UiMessage) => void,
    close: () => void,
  ) {
    const header = document.createElement('div');
    header.className = 'page-header';
    const back = document.createElement('button');
    back.textContent = '← 返回对话';
    back.onclick = close;
    const title = document.createElement('h2');
    title.textContent = '显示的模型';
    header.append(back, title);
    const note = document.createElement('p');
    note.textContent = '勾选的模型显示在对话框中。当前模型始终保留；不同 Agent 分别保存。';
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.placeholder = '搜索模型或供应商';
    this.search.setAttribute('aria-label', '搜索模型');
    this.search.oninput = () => this.filter();
    const actions = document.createElement('div');
    for (const [label, all] of [
      ['显示全部', true],
      ['仅保留当前模型', false],
    ] as const) {
      const button = document.createElement('button');
      button.textContent = label;
      button.onclick = () => this.save(all ? null : []);
      actions.append(button);
    }
    this.count = document.createElement('p');
    this.count.setAttribute('role', 'status');
    this.list = document.createElement('div');
    this.list.className = 'models-list';
    root.append(header, note, this.search, actions, this.count, this.list);
  }
  update(state?: ChatState) {
    this.state = state;
    const models = state
      ? sessionSelectors(state)
          .filter((c) => c.kind === 'model')
          .flatMap((c) => c.options)
      : [];
    const unique = [...new Map(models.map((m) => [m.id, m])).values()];
    const signature = JSON.stringify([state?.harness, unique, state?.visibleModels]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.list.replaceChildren();
    for (const model of unique) {
      const row = document.createElement('label');
      row.className = 'model-row';
      row.dataset.search = `${model.name} ${model.id}`.toLocaleLowerCase();
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = model.id;
      checkbox.checked = !state?.visibleModels || state.visibleModels.includes(model.id);
      checkbox.onchange = () =>
        this.save(
          [...this.list.querySelectorAll<HTMLInputElement>('input:checked')].map((c) => c.value),
        );
      const text = document.createElement('span');
      text.textContent = model.name;
      row.append(checkbox, text);
      this.list.append(row);
    }
    this.filter();
  }
  focus() {
    this.search.focus();
  }
  private save(models: string[] | null) {
    if (this.state)
      this.send({ type: 'setVisibleModels', harness: this.state.harness || 'pi', models });
  }
  private filter() {
    const query = this.search.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const row of this.list.querySelectorAll<HTMLElement>('.model-row')) {
      row.hidden = !row.dataset.search?.includes(query);
      if (!row.hidden) count++;
    }
    this.count.textContent = this.list.childElementCount
      ? `${count} / ${this.list.childElementCount} 个模型`
      : '连接会话后显示适配器提供的模型。';
  }
}

export function visibleModelSelector<
  T extends { kind: string; current: string; options: { id: string; name: string }[] },
>(control: T, visible?: string[]): T {
  return control.kind === 'model' && visible
    ? {
        ...control,
        options: control.options.filter((o) => o.id === control.current || visible.includes(o.id)),
      }
    : control;
}
