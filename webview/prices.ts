import type { Price } from '../src/telemetry';
import { priceFor } from '../src/telemetry';
import type { ChatState, UiMessage } from '../src/shared';
import { sessionSelectors } from './selectors';
import { modelProvider } from '../src/model-provider';
const labels = [
  ['input', '非缓存输入'],
  ['cacheRead', '缓存读取'],
  ['cacheWrite', '缓存写入'],
  ['output', '输出'],
] as const;
const text = (tag: string, value: string, className?: string) => {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
};
interface Card {
  node: HTMLElement;
  title: HTMLElement;
  visible: HTMLInputElement;
  context: HTMLInputElement;
  fields: Map<(typeof labels)[number][0], HTMLInputElement>;
  save: HTMLButtonElement;
  reset: HTMLButtonElement;
  status: HTMLElement;
  dirty: boolean;
  pending?: string;
}
/** One catalogue for visibility, context length and the four billing prices. */
export class ModelSettingsPage {
  private state?: ChatState;
  private scope = '';
  private cards = new Map<string, Card>();
  private groups = new Map<
    string,
    { node: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; reset: HTMLButtonElement }
  >();
  private batch?: { id: string; provider: string };
  private batchStatus: HTMLElement;
  private titleModel: HTMLSelectElement;
  private query = '';
  private beforeSearch = new Map<string, boolean>();
  private search: HTMLInputElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private count: HTMLElement;
  private back: HTMLButtonElement;
  constructor(
    root: HTMLElement,
    private send: (message: UiMessage) => void,
    back: () => void,
  ) {
    root.className = 'prices-page';
    const header = text('div', '', 'stats-heading');
    this.back = text('button', '返回对话') as HTMLButtonElement;
    this.back.type = 'button';
    this.back.className = 'page-back';
    this.back.onclick = back;
    const refresh = text('button', '刷新模型配置') as HTMLButtonElement;
    refresh.type = 'button';
    refresh.onclick = () => this.refresh();
    header.append(text('h2', '模型设置'), refresh, this.back);
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.placeholder = '搜索模型或供应商';
    this.search.setAttribute('aria-label', '搜索模型');
    this.search.oninput = () => this.filter();
    const titleSettings = text('label', '', 'title-model-setting');
    this.titleModel = document.createElement('select');
    this.titleModel.setAttribute('aria-label', '会话名压缩模型');
    this.titleModel.onchange = () =>
      this.send({ type: 'setTitleModel', model: this.titleModel.value });
    titleSettings.append(
      text('span', '会话名压缩模型（Pi）'),
      this.titleModel,
      text(
        'small',
        '只概括首条输入，约 8–16 字，不等待首轮回答；会产生少量额外模型用量。',
        'stats-caption',
      ),
    );
    this.batchStatus = text('p', '', 'model-settings-status');
    this.batchStatus.setAttribute('role', 'status');
    this.batchStatus.hidden = true;
    this.note = text('p', '', 'stats-caption');
    this.note.setAttribute('role', 'status');
    this.count = text('p', '', 'stats-caption');
    this.list = text('div', '', 'model-price-list');
    root.append(
      header,
      text(
        'p',
        '单价：USD / 百万 token。保存 / 恢复默认同时应用四项价格和 Pi context 长度；右上角勾选控制模型显示。其他 Agent 暂不支持修改 context。',
        'stats-caption',
      ),
      titleSettings,
      this.search,
      this.batchStatus,
      this.note,
      this.count,
      this.list,
    );
  }
  private refresh() {
    this.send({ type: 'refreshStatistics' });
  }
  update(state?: ChatState) {
    this.state = state;
    const scope = JSON.stringify([state?.harness, state?.sessionId]);
    if (scope !== this.scope) {
      this.scope = scope;
      this.cards.clear();
      this.groups.clear();
      this.batch = undefined;
      this.batchStatus.hidden = true;
      this.beforeSearch.clear();
      this.query = '';
      this.list.replaceChildren();
      this.search.value = '';
    }
    const configured = state
      ? sessionSelectors(state)
          .filter((c) => c.kind === 'model')
          .flatMap((c) => c.options)
      : [];
    const configuredIds = new Set(configured.map((m) => m.id));
    const choices = [
      { id: '', name: '跟随当前会话模型' },
      { id: 'off', name: '关闭自动命名' },
      ...(state?.harness === 'pi' ? configured : []),
    ];
    if (state?.titleModel && !choices.some((c) => c.id === state.titleModel))
      choices.push({ id: state.titleModel, name: state.titleModel });
    const titleSignature = JSON.stringify(choices);
    if (this.titleModel.dataset.signature !== titleSignature) {
      this.titleModel.replaceChildren(
        ...choices.map((choice) => new Option(choice.name, choice.id)),
      );
      this.titleModel.dataset.signature = titleSignature;
    }
    this.titleModel.value = state?.titleModel || '';
    this.titleModel.disabled = state?.harness !== 'pi' || state.status !== 'ready';
    const models = [
      ...new Map(
        [...(state?.statistics?.models || []), ...configured].map((m) => [m.id, m]),
      ).values(),
    ];
    const ids = new Set(models.map((m) => m.id));
    for (const [id, card] of this.cards)
      if (!ids.has(id)) {
        card.node.remove();
        this.cards.delete(id);
      }
    this.note.textContent = state?.statistics?.note || '';
    this.note.hidden = !this.note.textContent;
    const result = state?.providerSettingsResult;
    if (this.batch && result?.id === this.batch.id) {
      for (const model of result.models) {
        const card = this.cards.get(model);
        if (card) card.dirty = false;
      }
      this.batchStatus.textContent =
        result.error || `已恢复 ${result.models.length} 个模型的默认设置。`;
      this.batchStatus.hidden = false;
      this.batch = undefined;
    }
    const waiting =
      !!this.batch ||
      [...this.cards.values()].some(
        (card) => card.pending && card.pending !== state?.modelSettingsResult?.id,
      );
    for (const model of models) {
      let card = this.cards.get(model.id);
      if (!card) {
        const node = text('section', '', 'model-price-card model-row');
        node.setAttribute('aria-label', model.id);
        const title = text('h3', model.name || model.id);
        title.title = model.id;
        const visible = document.createElement('input');
        visible.type = 'checkbox';
        visible.value = model.id;
        visible.setAttribute('aria-label', `显示 ${model.name || model.id}`);
        visible.onchange = () => {
          if (this.state)
            this.send({
              type: 'setVisibleModels',
              harness: this.state.harness || 'pi',
              models: [...this.cards]
                .filter(([, c]) => !c.visible.disabled && c.visible.checked)
                .map(([id]) => id),
            });
        };
        const toggle = text('label', '', 'model-visibility');
        toggle.append(visible, text('span', '显示'));
        const heading = text('div', '', 'model-card-heading');
        heading.append(title, toggle);
        const grid = text('div', '', 'price-grid');
        const fields: Card['fields'] = new Map();
        const dirty = () => {
          const current = this.cards.get(model.id);
          if (current) {
            current.dirty = true;
            current.status.hidden = true;
          }
        };
        for (const [key, label] of labels) {
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '0';
          input.max = '1000000';
          input.step = 'any';
          input.required = true;
          input.setAttribute('aria-label', `${model.id} ${label}价格`);
          input.oninput = dirty;
          const wrapper = document.createElement('label');
          wrapper.append(text('span', label), input);
          grid.append(wrapper);
          fields.set(key, input);
        }
        const context = document.createElement('input');
        context.type = 'number';
        context.min = '0.001';
        context.max = '100000';
        context.step = '0.001';
        context.required = true;
        context.placeholder = '未提供';
        context.setAttribute('aria-label', `${model.name || model.id} context 长度（k tokens）`);
        context.oninput = dirty;
        const contextLabel = text('label', '', 'model-context-field');
        contextLabel.append(text('span', 'Context（k tokens）'), context);
        const save = text('button', '保存', 'primary') as HTMLButtonElement;
        const reset = text('button', '恢复默认') as HTMLButtonElement;
        save.type = reset.type = 'button';
        const buttons = text('div', '', 'model-settings-buttons');
        buttons.append(save, reset);
        const footer = text('div', '', 'model-settings-footer');
        footer.append(contextLabel, buttons);
        const status = text('p', '', 'model-settings-status');
        status.setAttribute('role', 'status');
        status.hidden = true;
        card = { node, title, visible, context, fields, save, reset, status, dirty: false };
        save.onclick = () => this.apply(model.id, false);
        reset.onclick = () => this.apply(model.id, true);
        node.append(heading, grid, footer, status);
        this.cards.set(model.id, card);
      }
      card.title.textContent = model.name || model.id;
      card.node.dataset.search = `${model.name} ${model.id}`.toLocaleLowerCase();
      card.visible.disabled = !configuredIds.has(model.id);
      card.visible.checked =
        configuredIds.has(model.id) &&
        (!state?.visibleModels || state.visibleModels.includes(model.id));
      const pi = state?.harness === 'pi';
      const editable =
        !!state &&
        !waiting &&
        state.status !== 'busy' &&
        state.status !== 'connecting' &&
        (!pi || (state.status === 'ready' && !!state.sessionId && configuredIds.has(model.id)));
      const result = state?.modelSettingsResult;
      if (card.pending && result?.id === card.pending && result.model === model.id) {
        card.pending = undefined;
        card.status.textContent = result.error || '已保存';
        card.status.hidden = false;
        if (!result.error) card.dirty = false;
      }
      card.context.disabled = !pi || !editable || !!card.pending;
      card.context.title = pi
        ? 'Pi context 长度（k tokens），1K = 1000 tokens；不会提高服务商的真实上限'
        : '当前 Agent 暂不支持修改 context';
      card.save.disabled = card.reset.disabled = !editable || !!card.pending;
      for (const input of card.fields.values()) input.disabled = !!card.pending || !!this.batch;
      if (!card.dirty && !card.pending) {
        const price = priceFor(model.id, state?.statistics?.prices || {});
        for (const [key, input] of card.fields) input.value = price ? String(price[key]) : '';
        card.context.value = state?.modelContexts?.[model.id]
          ? String(state.modelContexts[model.id] / 1000)
          : '';
      }
      const provider = modelProvider(model.id);
      let group = this.groups.get(provider);
      if (!group) {
        const node = document.createElement('details');
        node.className = 'provider-group';
        node.dataset.provider = provider;
        const summary = text('summary', provider);
        const controls = text('div', '', 'provider-actions');
        for (const [label, visible] of [
          ['全部显示', true],
          ['全部不显示', false],
        ] as const) {
          const button = text('button', label) as HTMLButtonElement;
          button.type = 'button';
          button.onclick = () => this.showProvider(provider, visible);
          controls.append(button);
        }
        const reset = text('button', '全部恢复默认') as HTMLButtonElement;
        reset.type = 'button';
        reset.onclick = () => this.resetProvider(provider);
        controls.append(reset);
        const body = text('div', '', 'provider-models');
        node.append(summary, controls, body);
        this.list.append(node);
        group = { node, summary, body, reset };
        this.groups.set(provider, group);
      }
      if (card.node.parentElement !== group.body) group.body.append(card.node);
    }
    for (const [provider, group] of this.groups) {
      if (!group.body.childElementCount) {
        group.node.remove();
        this.groups.delete(provider);
        continue;
      }
      group.summary.textContent = `${provider}（${group.body.childElementCount} 个模型）`;
      group.reset.disabled =
        waiting ||
        !state ||
        state.status !== 'ready' ||
        !configured.some((model) => modelProvider(model.id) === provider);
      for (const button of group.node.querySelectorAll<HTMLButtonElement>(
        '.provider-actions button',
      ))
        if (button !== group.reset) button.disabled = waiting;
    }
    this.titleModel.disabled ||= waiting;
    this.filter();
  }
  private showProvider(provider: string, visible: boolean) {
    if (!this.state || this.batch) return;
    const models = [...this.cards]
      .filter(
        ([id, card]) =>
          !card.visible.disabled &&
          (modelProvider(id) === provider ? visible : card.visible.checked),
      )
      .map(([id]) => id);
    this.send({ type: 'setVisibleModels', harness: this.state.harness || 'pi', models });
  }
  private resetProvider(provider: string) {
    const state = this.state;
    if (!state || this.groups.get(provider)?.reset.disabled) return;
    this.batch = { id: crypto.randomUUID(), provider };
    this.batchStatus.textContent = '请确认恢复默认设置…';
    this.batchStatus.hidden = false;
    this.send({
      type: 'resetProviderModels',
      ...this.batch,
      harness: state.harness || 'pi',
      sessionId: state.sessionId,
    });
    this.update(state);
  }
  private apply(model: string, reset: boolean) {
    const state = this.state,
      card = this.cards.get(model);
    if (!state || !card || card.save.disabled) return;
    const pi = state.harness === 'pi';
    if (!reset) {
      for (const input of card.fields.values()) if (!input.reportValidity()) return;
      if (pi && !card.context.reportValidity()) return;
    }
    const id = crypto.randomUUID();
    card.pending = id;
    card.dirty = true;
    card.status.textContent = reset ? '正在恢复默认…' : '正在保存…';
    card.status.hidden = false;
    this.send({
      type: 'setModelSettings',
      id,
      harness: state.harness || 'pi',
      sessionId: state.sessionId,
      model,
      values: reset
        ? null
        : {
            price: Object.fromEntries(
              [...card.fields].map(([key, input]) => [key, input.valueAsNumber]),
            ) as unknown as Price,
            ...(pi ? { contextWindow: Math.round(card.context.valueAsNumber * 1000) } : {}),
          },
    });
    this.update(state);
  }
  focus(model?: string) {
    if (model) {
      this.search.value = '';
      this.filter();
      const group = this.groups.get(modelProvider(model));
      if (group) group.node.open = true;
      this.cards.get(model)?.node.scrollIntoView({ block: 'start' });
    } else this.search.focus();
    this.refresh();
  }
  private filter() {
    const query = this.search.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const card of this.cards.values()) {
      card.node.hidden = !card.node.dataset.search?.includes(query);
      if (!card.node.hidden) count++;
    }
    if (query && !this.query)
      this.beforeSearch = new Map([...this.groups].map(([id, group]) => [id, group.node.open]));
    for (const [id, group] of this.groups) {
      const matches = [...group.body.children].some((child) => !(child as HTMLElement).hidden);
      group.node.hidden = !matches;
      if (query && matches) group.node.open = true;
      else if (!query && this.query) group.node.open = this.beforeSearch.get(id) || false;
    }
    this.query = query;
    this.count.textContent = this.cards.size
      ? `${count} / ${this.cards.size} 个模型`
      : '连接会话后显示模型。';
  }
}
