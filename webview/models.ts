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
    note.textContent =
      '勾选的模型显示在对话框中。Pi context 长度按 tokens 设置，写入 Pi models.json，供同一配置目录的会话共用；不会提高服务商的真实上限。其他 Agent 暂不支持修改。';
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
    const refresh = document.createElement('button');
    refresh.textContent = '刷新 Pi 模型配置';
    refresh.onclick = () => this.refreshContexts();
    actions.append(refresh);
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
    const signature = JSON.stringify([
      state?.harness,
      state?.sessionId,
      state?.status,
      unique,
      state?.visibleModels,
      state?.modelContexts,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.list.replaceChildren();
    for (const model of unique) {
      const row = document.createElement('div');
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
      const label = document.createElement('label');
      label.className = 'model-name';
      label.append(checkbox, text);
      const context = document.createElement('input');
      context.type = 'number';
      context.min = '1';
      context.max = '100000000';
      context.step = '1';
      context.setAttribute('aria-label', `${model.name} context 长度（tokens）`);
      context.placeholder = '未提供';
      const size = state?.modelContexts?.[model.id];
      if (size) context.value = String(size);
      const disabled = state?.harness !== 'pi' || state?.status !== 'ready' || !state?.sessionId;
      context.disabled = disabled;
      const save = document.createElement('button');
      save.textContent = '保存';
      save.disabled = disabled;
      const reset = document.createElement('button');
      reset.textContent = '恢复默认';
      reset.disabled = disabled;
      const apply = (value: number | null) => {
        const current = this.state;
        if (current?.harness === 'pi' && current.sessionId && current.status === 'ready')
          this.send({
            type: 'setModelContext',
            harness: 'pi',
            sessionId: current.sessionId,
            model: model.id,
            contextWindow: value,
          });
      };
      save.onclick = () => {
        if (context.value && context.reportValidity()) apply(Number(context.value));
      };
      reset.onclick = () => apply(null);
      const editor = document.createElement('div');
      editor.className = 'model-context';
      const caption = document.createElement('span');
      caption.textContent = 'Context（tokens）';
      editor.append(caption, context, save, reset);
      row.append(label, editor);
      this.list.append(row);
    }
    this.filter();
  }
  focus() {
    this.search.focus();
    this.refreshContexts();
  }
  private refreshContexts() {
    const state = this.state;
    if (state?.harness === 'pi' && state.sessionId && state.status === 'ready')
      this.send({ type: 'refreshModelContexts', harness: 'pi', sessionId: state.sessionId });
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
