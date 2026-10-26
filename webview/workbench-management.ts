import { uiLabel } from './workbench-labels';
import {
  managementData,
  type ManagementData,
  type ManagementQuery,
  type ManagementAction,
  type SessionView,
  type SessionSummary,
} from '../src/workbench-protocol';
import type { UiCommand, UiOperation } from '../src/workbench-ui';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (text: string, run: () => void) => {
  const n = el('button', uiLabel(text));
  n.type = 'button';
  n.onclick = run;
  return n;
};
const field = (label: string, input: HTMLElement) => {
  const n = el('label', label);
  n.append(input);
  return n;
};
export class ManagementPanel {
  readonly root = el('details');
  private body = el('section');
  private status = el('p');
  private data?: ManagementData;
  private view?: SessionView;
  private sessions: SessionSummary[] = [];
  private request = 0;
  private pending = 0;
  private mode: 'models' | 'statistics' = 'models';
  private filter: ManagementQuery = {};
  private seen = new Set<string>();
  private search = '';
  private modelDrafts = new Map<string, { value: string; checked: boolean }[]>();
  private focusSearch = false;
  private extraOpen = { models: false, statistics: false };
  private expanded = new Set<string>();
  constructor(
    private send: (m: UiCommand) => void,
    private changed: () => void,
  ) {
    this.root.id = 'management';
    const heading = el('div');
    heading.className = 'stats-heading';
    const back = button('返回对话', () => {
      this.root.open = false;
      this.changed();
    });
    back.className = 'page-back';
    heading.append(
      el('h2', '模型设置'),
      button('刷新模型配置', () => {
        if (this.mode === 'models') this.mutate({ action: 'refresh_models' });
        else this.load();
      }),
      back,
    );
    this.status.className = 'stats-caption';
    this.root.append(el('summary', '模型与用量'), heading, this.status, this.body);
    this.root.addEventListener('toggle', () => {
      this.changed();
      if (this.root.open && !this.data && !this.pending) this.load();
    });
  }
  setView(view: SessionView | undefined, sessions: SessionSummary[], operations: UiOperation[]) {
    const switched = this.view?.id !== view?.id;
    if (switched) this.modelDrafts.clear();
    this.view = view;
    this.sessions = sessions;
    let updated = false;
    for (const op of operations)
      if (op.method === 'manage' && op.status === 'completed' && !this.seen.has(op.operation)) {
        this.seen.add(op.operation);
        while (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!);
        updated = true;
      }
    if (updated || (switched && this.root.open)) this.load();
    // Read-only account preferences, never discovery or native configuration.
    if (!this.data && !this.pending && view?.catalogue.models.length) this.load();
  }
  private load(cursor?: string) {
    this.pending = ++this.request;
    for (const input of this.body.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('input,select,button'))
      input.disabled = true;
    this.status.textContent = '正在读取设置与用量…';
    this.send({
      type: 'read_management',
      request_id: this.pending,
      query: { ...this.filter, cursor },
    });
  }
  receive(raw: unknown) {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return false;
    const m = raw as { type: string; request_id?: number; data?: unknown; error?: unknown };
    if (!['management', 'management_error'].includes(m.type)) return false;
    if (m.request_id !== this.pending) return true;
    this.pending = 0;
    for (const input of this.body.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('input,select,button'))
      input.disabled = false;
    if (m.type === 'management_error') {
      this.status.textContent = '暂时无法读取设置与用量，请手动刷新。';
      return true;
    }
    try {
      this.data = managementData.parse(m.data);
      this.status.textContent =
        this.mode === 'models' ? '' : '费用按模型设置中的单价估算；缺失用量单独统计，不按零计算。';
      this.render();
      this.changed();
    } catch {
      this.status.textContent = '设置或用量数据格式无效';
    }
    return true;
  }
  visible(model: string, harness: string) {
    return !this.data?.models.some((m) => m.harness === harness && m.model === model && m.hidden);
  }
  openStatistics() {
    this.root.open = true;
    this.root.dataset.page = 'statistics';
    this.mode = 'statistics';
    this.root.className = 'statistics-page';
    this.root.querySelector('h2')!.textContent = '用量统计';
    this.filter = { group: 'model' };
    this.load();
  }
  openModels() {
    this.root.open = true;
    this.root.dataset.page = 'models';
    this.focusSearch = true;
    this.mode = 'models';
    this.root.className = 'prices-page';
    this.root.querySelector('h2')!.textContent = '模型设置';
    this.filter = {};
    this.load();
  }
  private mutate(action: ManagementAction) {
    if (!this.view) {
      this.status.textContent = '请先选择会话';
      return;
    }
    this.send({
      type: 'execute',
      session: this.view.id,
      command: { method: 'manage', session: this.view.id, action },
    });
    this.status.textContent = '正在保存；结果不确定时不会自动重试。';
  }
  private render() {
    for (const card of this.body.querySelectorAll<HTMLDetailsElement>('details[data-provider]')) {
      if (card.open) this.expanded.add(card.dataset.provider!);
      else this.expanded.delete(card.dataset.provider!);
    }
    while (this.expanded.size > 128) this.expanded.delete(this.expanded.values().next().value!);
    const previousExtra = this.body.querySelector<HTMLDetailsElement>('.additional-settings');
    if (previousExtra?.dataset.mode)
      this.extraOpen[previousExtra.dataset.mode as 'models' | 'statistics'] = previousExtra.open;
    this.body.replaceChildren();
    this.root.insertBefore(this.status, this.body);
    this.status.className = 'stats-caption';
    if (!this.view) {
      this.body.append(el('p', '请先选择或新建会话，再管理模型。'));
      return;
    }
    if (this.mode === 'statistics') {
      this.statistics();
      return;
    }
    const summary = this.sessions.find((s) => s.id === this.view!.id);
    const title = el('input');
    title.value = summary?.title ?? '';
    title.maxLength = 80;
    title.setAttribute('aria-label', 'Session name');
    const extra = el('details');
    extra.className = 'additional-settings';
    extra.dataset.mode = 'models';
    extra.open = this.extraOpen.models;
    extra.append(el('summary', '会话命名与其他设置'));
    extra.append(
      field(`会话 #${summary?.created_seq ?? '?'} 名称`, title),
      button('Save session name', () => this.mutate({ action: 'rename', title: title.value })),
    );
    const naming = el('select');
    naming.setAttribute('aria-label', 'Automatic title policy');
    for (const [value, name] of [
      ['follow', '跟随当前 Pi 模型'],
      ['off', '关闭（仅使用输入摘要）'],
      ['model', '指定 Pi 模型'],
    ]) {
      const option = el('option', name);
      option.value = value;
      naming.append(option);
    }
    naming.value = this.data?.naming_policy ?? 'follow';
    const titleModel = el('input');
    titleModel.value = this.data?.title_model ?? '';
    titleModel.placeholder = 'provider/model';
    titleModel.setAttribute('aria-label', '命名模型');
    extra.append(
      field('自动命名', naming),
      field('命名模型', titleModel),
      button('保存命名设置', () =>
        this.mutate({
          action: 'naming',
          policy: naming.value as 'off' | 'follow' | 'model',
          model: titleModel.value || null,
        }),
      ),
      el(
        'p',
        'Pi 在首个任务后单独生成标题，最多等待 15 秒，用量单独记录。其他 Agent 使用本地输入摘要，已有名称不会覆盖。',
      ),
    );
    extra.append(
      button('刷新模型目录', () => this.mutate({ action: 'refresh_models' })),
      el(
        'p',
        '刷新目录或调整上下文可能启动空闲 Agent，需要已信任的工作区。不支持的设置会明确提示。',
      ),
    );
    const titleSettings = el('label');
    titleSettings.className = 'title-model-setting';
    const titleChoice = el('select');
    titleChoice.setAttribute('aria-label', '会话名压缩模型');
    for (const [value, label] of [
      ['', '跟随当前会话模型'],
      ['off', '关闭自动命名'],
      ...this.view.catalogue.models.map((m) => [m.id, m.name]),
    ]) {
      const option = el('option', label);
      option.value = value;
      titleChoice.append(option);
    }
    titleChoice.value = this.data?.naming_policy === 'off' ? 'off' : this.data?.title_model || '';
    titleChoice.onchange = () =>
      this.mutate({
        action: 'naming',
        policy: titleChoice.value === 'off' ? 'off' : titleChoice.value ? 'model' : 'follow',
        model: !titleChoice.value || titleChoice.value === 'off' ? null : titleChoice.value,
      });
    titleSettings.append(
      el('span', '会话名压缩模型（Pi）'),
      titleChoice,
      el('small', 'Pi 在首条输入后单独生成标题，用量单独记录。'),
    );
    this.body.append(titleSettings);
    const search = el('input');
    search.type = 'search';
    search.value = this.search;
    search.placeholder = '搜索模型或供应商';
    search.setAttribute('aria-label', 'Model search');
    const list = el('div');
    list.className = 'model-price-list';
    const render = () => {
      list.replaceChildren();
      const known = new Map<string, string>();
      for (const m of this.view!.catalogue.models) known.set(m.id, m.name);
      for (const m of this.data?.models ?? [])
        if (m.harness === this.view!.harness && !known.has(m.model)) known.set(m.model, m.model);
      const groups = new Map<string, [string, string][]>();
      for (const row of known) {
        const provider = row[0].includes('/') ? row[0].split('/')[0] : '当前供应商';
        if (!groups.has(provider)) groups.set(provider, []);
        groups.get(provider)!.push(row);
      }
      let shown = 0;
      for (const [provider, models] of groups) {
        const matching = models.filter(([id, name]) =>
          `${provider} ${id} ${name}`.toLowerCase().includes(search.value.toLowerCase()),
        );
        if (!matching.length) continue;
        const group = el('details');
        group.className = 'provider-group';
        group.dataset.provider = provider;
        group.open = this.expanded.has(provider) || !!search.value;
        group.append(el('summary', `${provider}（${matching.length} 个模型）`));
        group.ontoggle = () => {
          if (!group.isConnected) return;
          if (group.open) this.expanded.add(provider);
          else this.expanded.delete(provider);
        };
        const controls = el('div');
        controls.className = 'provider-actions';
        const modelsBody = el('div');
        modelsBody.className = 'provider-models';
        group.append(controls, modelsBody);
        list.append(group);
        for (const [label, hidden, reset] of [
          ['显示全部模型', false, false],
          ['隐藏全部模型', true, false],
          ['恢复默认显示', false, true],
        ] as const)
          controls.append(
            button(label, () =>
              this.mutate({
                action: 'visibility',
                models: models.slice(0, 500).map((m) => m[0]),
                hidden,
                reset,
              }),
            ),
          );
        for (const [model, name] of matching) {
          if (++shown > 100) break;
          const saved = this.data?.models.find(
            (m) => m.harness === this.view!.harness && m.model === model,
          );
          const card = el('section');
          card.className = 'model-price-card model-row';
          card.dataset.model = `${this.view!.harness}:${model}`;
          const modelHeading = el('div');
          modelHeading.className = 'model-card-heading';
          modelHeading.append(el('h3', name));
          card.append(modelHeading);
          const visible = el('input');
          visible.type = 'checkbox';
          visible.checked = !saved?.hidden;
          const visibility = field('显示', visible);
          visibility.className = 'model-visibility';
          visible.setAttribute('aria-label', 'Visible in model selector');
          modelHeading.append(visibility);
          const grid = el('div');
          grid.className = 'price-grid';
          card.append(grid);
          const price = saved?.price ?? saved?.default_price;
          const priceNote = el(
            'small',
            saved?.price ? '自定义价格' : price ? '默认价格' : '暂无价格',
          );
          priceNote.className = 'stats-caption';
          card.title = model;
          const inputs = (['input', 'cache_read', 'cache_write', 'output'] as const).map((key) => {
            const n = el('input');
            n.type = 'number';
            n.min = '0';
            n.max = '1000000';
            n.step = 'any';
            n.value = price?.[key]?.toString() ?? '';
            n.setAttribute('aria-label', `${model} ${key} price`);
            grid.append(
              field(
                (
                  {
                    input: '非缓存输入',
                    output: '输出',
                    cache_read: '缓存读取',
                    cache_write: '缓存写入',
                  } as const
                )[key],
                n,
              ),
            );
            return n;
          });
          const context = el('input');
          context.type = 'number';
          context.min = '0.001';
          context.max = '100000';
          context.step = 'any';
          context.value = saved?.context_window ? (saved.context_window / 1000).toString() : '';
          context.disabled = this.view!.harness !== 'Pi';
          context.setAttribute('aria-label', `${model} context k tokens`);
          const footer = el('div');
          footer.className = 'model-settings-footer';
          const contextField = field('Context（k tokens）', context);
          contextField.className = 'model-context-field';
          footer.append(contextField);
          card.append(footer);
          const actions = el('div');
          actions.className = 'model-settings-buttons';
          footer.append(actions);
          actions.append(
            button('保存价格与显示设置', () => {
              if (
                inputs.some(
                  (n) =>
                    n.value === '' ||
                    !Number.isFinite(Number(n.value)) ||
                    Number(n.value) < 0 ||
                    Number(n.value) > 1000000,
                )
              ) {
                this.status.textContent = '请填写四项有效的非负价格，或恢复默认价格。';
                return;
              }
              this.mutate({
                action: 'model',
                model,
                hidden: !visible.checked,
                price: {
                  input: Number(inputs[0].value),
                  output: Number(inputs[3].value),
                  cache_read: Number(inputs[1].value),
                  cache_write: Number(inputs[2].value),
                },
              });
            }),
            button('保存显示设置', () =>
              this.mutate({
                action: 'model',
                model,
                hidden: !visible.checked,
                price: saved?.price ?? null,
              }),
            ),
            button('恢复默认价格与显示', () =>
              this.mutate({ action: 'model', model, hidden: false, price: null }),
            ),
          );
          if (this.view!.harness === 'Pi')
            card.append(
              button('应用上下文设置', () => {
                const tokens = Number(context.value) * 1000;
                if (
                  !context.value ||
                  !Number.isSafeInteger(tokens) ||
                  tokens <= 0 ||
                  tokens > 100000000
                ) {
                  this.status.textContent = '上下文必须是正整数 Token 数量';
                  return;
                }
                this.mutate({ action: 'context', model, context_window: tokens });
              }),
              button('恢复默认上下文', () =>
                this.mutate({ action: 'context', model, context_window: null }),
              ),
            );
          modelsBody.append(card);
          const draftKey = `${this.view!.id}:${model}`;
          const fields = [...card.querySelectorAll<HTMLInputElement>('input')];
          const draft = this.modelDrafts.get(draftKey);
          if (draft)
            fields.forEach((input, i) => {
              if (draft[i]) {
                input.value = draft[i].value;
                input.checked = draft[i].checked;
              }
            });
          card.addEventListener('input', () => {
            this.modelDrafts.set(
              draftKey,
              fields.map((input) => ({ value: input.value, checked: input.checked })),
            );
            while (this.modelDrafts.size > 100)
              this.modelDrafts.delete(this.modelDrafts.keys().next().value!);
          });
        }
      }
      if (!shown) list.append(el('p', '没有匹配的模型。请加载 Agent 会话或刷新模型目录。'));
      if (shown > 100) list.append(el('p', '仅显示前 100 项，请缩小搜索范围。'));
      this.decorateModels(list);
    };
    search.oninput = () => {
      this.search = search.value;
      render();
    };
    search.className = 'model-search';
    this.body.prepend(
      el(
        'p',
        '单价：USD / 百万 token。四项价格与 Pi context 分别保存；右上角勾选控制模型显示。其他 Agent 暂不支持修改 context。',
      ),
    );
    const count = el(
      'p',
      `${this.view.catalogue.models.length} / ${this.view.catalogue.models.length} 个模型`,
    );
    count.className = 'stats-caption';
    this.body.append(search, count, list, extra);
    render();
    if (this.focusSearch) {
      this.focusSearch = false;
      search.focus();
    }
  }
  private decorateModels(list: HTMLElement) {
    for (const button of list.querySelectorAll('button')) {
      const label = button.textContent!;
      button.setAttribute('aria-label', label);
      if (label === '保存价格与显示设置') {
        button.textContent = '保存';
        button.classList.add('primary');
      }
      if (label === '显示全部模型') button.textContent = '全部显示';
      if (label === '隐藏全部模型') button.textContent = '全部不显示';
      if (label === '恢复默认显示') button.textContent = '全部恢复默认';
      if (label === '保存显示设置') {
        button.hidden = true;
        const checkbox = button
          .closest('[data-model]')!
          .querySelector<HTMLInputElement>('input[type=checkbox]')!;
        checkbox.onchange = () => button.click();
      }
      if (label === '应用上下文设置') {
        button.textContent = '应用';
        button.className = 'apply-context';
        button.closest('[data-model]')!.querySelector('.model-context-field')!.append(button);
      }
      if (label === '恢复默认上下文') {
        button.hidden = true;
        const context = button
          .closest('[data-model]')!
          .querySelector<HTMLInputElement>('input[type=number][aria-label$="context k tokens"]')!;
        context.oncontextmenu = (event) => {
          event.preventDefault();
          button.click();
        };
      }
      if (label === '恢复默认价格与显示') button.textContent = '恢复默认';
    }
  }
  private statistics() {
    const group = el('select');
    group.setAttribute('aria-label', 'Statistics grouping');
    for (const v of ['model', 'day', 'week', 'month', 'session']) {
      const option = el(
        'option',
        (
          {
            model: '按模型',
            day: '按日',
            week: '按周',
            month: '按月',
            session: '按会话',
          } as Record<string, string>
        )[v],
      );
      option.value = v;
      group.append(option);
    }
    group.value = this.filter.group ?? 'model';
    const from = el('input'),
      to = el('input');
    from.type = to.type = 'date';
    from.setAttribute('aria-label', 'Usage from date');
    to.setAttribute('aria-label', 'Usage to date');
    if (this.filter.from) from.value = new Date(this.filter.from).toISOString().slice(0, 10);
    if (this.filter.to) to.value = new Date(this.filter.to).toISOString().slice(0, 10);
    const model = el('input');
    model.placeholder = '模型 ID（留空显示全部）';
    model.value = this.filter.model ?? '';
    model.setAttribute('aria-label', 'Usage model filter');
    const session = el('select');
    session.setAttribute('aria-label', 'Usage session filter');
    const all = el('option', '全部会话');
    all.value = '';
    session.append(all);
    for (const s of this.sessions) {
      const option = el('option', `#${s.created_seq} ${s.title ?? s.id}`);
      option.value = s.id;
      session.append(option);
    }
    session.value = this.filter.session ?? '';
    const filters = el('div');
    filters.className = 'stats-filters';
    filters.append(
      field('分组', group),
      field('开始日期（UTC）', from),
      field('结束日期（UTC，含当日）', to),
      model,
      session,
      button('应用筛选', () => {
        this.filter = {
          group: group.value as ManagementQuery['group'],
          from: from.value ? Date.parse(from.value) : null,
          to: to.value ? Date.parse(to.value) + 86399999 : null,
          model: model.value || null,
          session: session.value ? (session.value as SessionView['id']) : null,
        };
        this.load();
      }),
    );
    const advanced = el('details');
    advanced.className = 'additional-settings';
    advanced.dataset.mode = 'statistics';
    advanced.open = this.extraOpen.statistics;
    advanced.append(el('summary', '更多筛选'), group, model, session);
    const apply = filters.querySelector<HTMLButtonElement>('button')!;
    advanced.append(apply);
    filters.replaceChildren(
      from,
      el('span', '至'),
      to,
      button('全部日期', () => {
        from.value = '';
        to.value = '';
        apply.click();
      }),
    );
    from.onchange = to.onchange = () => apply.click();
    this.body.append(filters);
    const totals = el('div');
    totals.className = 'stats-totals';
    const t = this.data?.totals;
    for (const [label, value] of [
      ['总输入', t ? (t.input + t.cache_read + t.cache_write).toLocaleString() : '—'],
      ['输出', t?.output.toLocaleString() ?? '—'],
      [
        '缓存命中',
        t && !t.cache_missing && t.input + t.cache_read + t.cache_write
          ? ((100 * t.cache_read) / (t.input + t.cache_read + t.cache_write)).toFixed(1) + '%'
          : '—',
      ],
      ['估算费用', t ? '$' + t.estimated_usd.toFixed(4) : '—'],
    ]) {
      const card = el('div');
      card.className = 'stats-card';
      card.append(el('span', label), el('strong', value));
      totals.append(card);
    }
    this.body.prepend(el('p', 'Workbench 会话 · 日期按 UTC · 费用单位 USD'));
    this.status.className = 'stats-note';
    this.body.insertBefore(this.status, filters);
    this.body.append(totals);
    if (t && (t.missing || t.cache_missing || t.unpriced))
      this.body.append(
        el(
          'p',
          `缺失用量 ${t.missing} · 缺失缓存 ${t.cache_missing} · 未定价 ${t.unpriced}；费用仅为已知部分的估算。`,
        ),
      );
    const tabs = el('div');
    tabs.className = 'stats-tabs';
    tabs.setAttribute('role', 'tablist');
    for (const [value, label] of [
      ['model', '按模型'],
      ['day', '按时间'],
      ['session', '按会话'],
    ]) {
      const tab = button(label, () => {
        this.filter = { ...this.filter, group: value as ManagementQuery['group'] };
        this.load();
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute(
        'aria-selected',
        String(
          (this.filter.group ?? 'model') === value ||
            (value === 'day' && ['week', 'month'].includes(this.filter.group!)),
        ),
      );
      tabs.append(tab);
    }
    this.body.append(tabs);
    const rows = this.data?.groups ?? [];
    if (['day', 'week', 'month'].includes(this.filter.group || '')) {
      const intervals = el('div');
      intervals.className = 'stats-tabs time-intervals';
      intervals.setAttribute('aria-label', '费用时间粒度');
      for (const [value, label] of [
        ['day', '按天'],
        ['week', '按周'],
        ['month', '按月'],
      ]) {
        const b = button(label, () => {
          this.filter = { ...this.filter, group: value as ManagementQuery['group'] };
          this.load();
        });
        b.setAttribute('aria-pressed', String(value === this.filter.group));
        intervals.append(b);
      }
      const chart = el('div');
      chart.className = 'usage-chart';
      const maximum = Math.max(0.000001, ...rows.map((r) => r.estimated_usd));
      for (const r of rows) {
        const column = el('div');
        column.className = 'usage-column';
        const value = el('div', '$' + r.estimated_usd.toFixed(4));
        value.className = 'usage-bar-value';
        const track = el('div');
        track.className = 'usage-bar-track';
        const bar = el('div');
        bar.className = 'usage-bar';
        bar.style.height = (100 * r.estimated_usd) / maximum + '%';
        const label = el('div', r.label || r.key);
        label.className = 'usage-bar-label';
        track.append(bar);
        column.append(value, track, label);
        chart.append(column);
      }
      this.body.append(intervals, chart, advanced);
      if (this.data?.next_cursor)
        this.body.append(button('下一页统计', () => this.load(this.data!.next_cursor!)));
      return;
    }
    const table = el('table');
    const head = el('tr');
    for (const name of [
      this.filter.group === 'session' ? '会话' : '模型',
      '缓存命中',
      '总输入',
      '输出',
      '命中率',
      '估算费用',
    ])
      head.append(el('th', name));
    table.append(head);
    const max = Math.max(
      0.000001,
      ...rows.filter((r) => r.key !== 'total').map((r) => r.estimated_usd),
    );
    for (const r of rows) {
      const tr = el('tr');
      tr.title = `调用 ${r.calls} 次；用量缺失 ${r.missing}；缓存缺失 ${r.cache_missing}；未定价 ${r.unpriced}`;
      const key = el('td');
      const label = r.key === 'total' ? '筛选合计' : this.sessions.find((s) => s.id === r.key);
      const text =
        r.key === 'total'
          ? '筛选合计'
          : (r.label ??
            (typeof label === 'object'
              ? `#${label.created_seq} ${label.title ?? label.id}`
              : r.key));
      if (this.filter.group === 'model' && r.key !== 'total')
        key.append(
          button(text, () => {
            this.search = r.key.replace(/^(Pi|Codex|Claude)\//, '');
            this.openModels();
          }),
        );
      else key.textContent = text;
      tr.append(
        key,
        ...[
          r.cache_read.toLocaleString(),
          (r.input + r.cache_read + r.cache_write).toLocaleString(),
          r.output.toLocaleString(),
          r.cache_missing
            ? '未知'
            : r.input + r.cache_read + r.cache_write
              ? ((100 * r.cache_read) / (r.input + r.cache_read + r.cache_write)).toFixed(1) + '%'
              : '—',
          '$' + r.estimated_usd.toFixed(4),
        ].map((v) => el('td', String(v))),
      );
      if (['day', 'week', 'month'].includes(this.filter.group ?? '') && r.key !== 'total') {
        const bar = el('meter');
        bar.min = 0;
        bar.max = max;
        bar.value = r.estimated_usd;
        bar.setAttribute('aria-label', `${r.key} estimated USD`);
        key.append(bar);
      }
      table.append(tr);
    }
    const tableWrap = el('div');
    tableWrap.className = 'stats-table-wrap';
    tableWrap.append(table);
    this.body.append(
      tableWrap,
      advanced,
      el(
        'p',
        '仅记录 Workbench 接受的调用，加载原生会话和分支继承历史不重复计费。缺失用量单独统计，不按零计算；推理和独立命名各记录一次。',
      ),
    );
    if (this.data?.next_cursor)
      this.body.append(button('下一页统计', () => this.load(this.data!.next_cursor!)));
  }
}
