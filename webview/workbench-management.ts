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
  const n = el('button', text);
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
  private expanded = new Set<string>();
  constructor(
    private send: (m: UiCommand) => void,
    private changed: () => void,
  ) {
    this.root.id = 'management';
    this.root.append(el('summary', 'Usage and model settings'), this.status, this.body);
    this.root.addEventListener('toggle', () => {
      if (this.root.open && !this.data && !this.pending) this.load();
    });
  }
  setView(view: SessionView | undefined, sessions: SessionSummary[], operations: UiOperation[]) {
    const switched = this.view?.id !== view?.id;
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
    this.status.textContent = 'Loading saved settings / indexed statistics…';
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
      this.status.textContent = 'Settings/statistics unavailable. Refresh explicitly to retry.';
      return true;
    }
    try {
      this.data = managementData.parse(m.data);
      this.status.textContent =
        'Saved settings. Costs are estimates, not provider bills. Missing usage/cache/prices are not zero.';
      this.render();
      this.changed();
    } catch {
      this.status.textContent = 'Invalid settings/statistics response';
    }
    return true;
  }
  visible(model: string, harness: string) {
    return !this.data?.models.some((m) => m.harness === harness && m.model === model && m.hidden);
  }
  openStatistics() {
    this.root.open = true;
    this.mode = 'statistics';
    this.filter = { group: 'model' };
    this.load();
  }
  openModels() {
    this.root.open = true;
    this.mode = 'models';
    this.filter = {};
    this.load();
  }
  private mutate(action: ManagementAction) {
    if (!this.view) {
      this.status.textContent = 'Select a session first';
      return;
    }
    this.send({
      type: 'execute',
      session: this.view.id,
      command: { method: 'manage', session: this.view.id, action },
    });
    this.status.textContent =
      'Saving explicitly; unknown outcomes are never automatically retried.';
  }
  private render() {
    for (const card of this.body.querySelectorAll<HTMLDetailsElement>('details[data-model]')) {
      if (card.open) this.expanded.add(card.dataset.model!);
      else this.expanded.delete(card.dataset.model!);
    }
    while (this.expanded.size > 128) this.expanded.delete(this.expanded.values().next().value!);
    this.body.replaceChildren();
    this.body.append(
      button('Model settings', () => this.openModels()),
      button('Usage statistics', () => this.openStatistics()),
      button('Refresh saved data', () => this.load()),
    );
    if (!this.view) {
      this.body.append(el('p', 'Select or create a session to manage models.'));
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
    this.body.append(
      field(`Session #${summary?.created_seq ?? '?'} name`, title),
      button('Save session name', () => this.mutate({ action: 'rename', title: title.value })),
    );
    const naming = el('select');
    naming.setAttribute('aria-label', 'Automatic title policy');
    for (const [value, name] of [
      ['follow', 'Follow current Pi model'],
      ['off', 'Off (short input title only)'],
      ['model', 'Use specified Pi model'],
    ]) {
      const option = el('option', name);
      option.value = value;
      naming.append(option);
    }
    naming.value = this.data?.naming_policy ?? 'follow';
    const titleModel = el('input');
    titleModel.value = this.data?.title_model ?? '';
    titleModel.placeholder = 'provider/model';
    titleModel.setAttribute('aria-label', 'Title model');
    this.body.append(
      field('Automatic naming', naming),
      field('Title model', titleModel),
      button('Save naming policy', () =>
        this.mutate({
          action: 'naming',
          policy: naming.value as 'off' | 'follow' | 'model',
          model: titleModel.value || null,
        }),
      ),
      el(
        'p',
        'Pi names use a separate tool-free call after the first task; at most 15 s, usage recorded separately. Other providers use a short local input title. Existing/manual names are not overwritten.',
      ),
    );
    this.body.append(
      button('Refresh provider models explicitly', () => this.mutate({ action: 'refresh_models' })),
      el(
        'p',
        'Provider refresh/context may start an idle provider only after workspace authorization. Non-negotiating providers retain their actual ACP catalogue and report unsupported.',
      ),
    );
    const search = el('input');
    search.type = 'search';
    search.value = this.search;
    search.placeholder = 'Search models / providers';
    search.setAttribute('aria-label', 'Model search');
    const list = el('section');
    const render = () => {
      list.replaceChildren();
      const known = new Map<string, string>();
      for (const m of this.view!.catalogue.models) known.set(m.id, m.name);
      for (const m of this.data?.models ?? [])
        if (m.harness === this.view!.harness && !known.has(m.model)) known.set(m.model, m.model);
      const groups = new Map<string, [string, string][]>();
      for (const row of known) {
        const provider = row[0].includes('/') ? row[0].split('/')[0] : this.view!.harness;
        if (!groups.has(provider)) groups.set(provider, []);
        groups.get(provider)!.push(row);
      }
      let shown = 0;
      for (const [provider, models] of groups) {
        const matching = models.filter(([id, name]) =>
          `${provider} ${id} ${name}`.toLowerCase().includes(search.value.toLowerCase()),
        );
        if (!matching.length) continue;
        list.append(el('h3', provider));
        for (const [label, hidden, reset] of [
          ['Show provider', false, false],
          ['Hide provider', true, false],
          ['Restore provider defaults', false, true],
        ] as const)
          list.append(
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
          const card = el('details');
          card.dataset.model = `${this.view!.harness}:${model}`;
          card.open = this.expanded.has(card.dataset.model);
          card.append(el('summary', name));
          card.addEventListener('toggle', () => {
            if (!card.isConnected) return;
            if (card.open) this.expanded.add(card.dataset.model!);
            else this.expanded.delete(card.dataset.model!);
          });
          const visible = el('input');
          visible.type = 'checkbox';
          visible.checked = !saved?.hidden;
          card.append(field('Visible in model selector', visible), el('p', model));
          const price = saved?.price ?? saved?.default_price;
          card.append(
            el(
              'p',
              saved?.price
                ? 'User override · USD per 1M tokens'
                : price
                  ? 'Provider default · USD per 1M tokens'
                  : 'Unpriced · enter all four prices to estimate',
            ),
          );
          const inputs = (['input', 'output', 'cache_read', 'cache_write'] as const).map((key) => {
            const n = el('input');
            n.type = 'number';
            n.min = '0';
            n.max = '1000000';
            n.step = 'any';
            n.value = price?.[key]?.toString() ?? '';
            n.setAttribute('aria-label', `${model} ${key} price`);
            card.append(field(key, n));
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
          card.append(
            field('Pi context (k tokens; explicit setting, not real provider capacity)', context),
          );
          card.append(
            button('Save prices / visibility', () => {
              if (
                inputs.some(
                  (n) =>
                    n.value === '' ||
                    !Number.isFinite(Number(n.value)) ||
                    Number(n.value) < 0 ||
                    Number(n.value) > 1000000,
                )
              ) {
                this.status.textContent =
                  'Enter four finite nonnegative prices; use Restore default for missing prices.';
                return;
              }
              this.mutate({
                action: 'model',
                model,
                hidden: !visible.checked,
                price: {
                  input: Number(inputs[0].value),
                  output: Number(inputs[1].value),
                  cache_read: Number(inputs[2].value),
                  cache_write: Number(inputs[3].value),
                },
              });
            }),
            button('Save visibility only', () =>
              this.mutate({
                action: 'model',
                model,
                hidden: !visible.checked,
                price: saved?.price ?? null,
              }),
            ),
            button('Restore default price / visibility', () =>
              this.mutate({ action: 'model', model, hidden: false, price: null }),
            ),
          );
          if (this.view!.harness === 'Pi')
            card.append(
              button('Apply Pi context explicitly', () => {
                const tokens = Number(context.value) * 1000;
                if (
                  !context.value ||
                  !Number.isSafeInteger(tokens) ||
                  tokens <= 0 ||
                  tokens > 100000000
                ) {
                  this.status.textContent = 'Context must be a positive integral token count';
                  return;
                }
                this.mutate({ action: 'context', model, context_window: tokens });
              }),
              button('Restore Pi context default', () =>
                this.mutate({ action: 'context', model, context_window: null }),
              ),
            );
          list.append(card);
        }
      }
      if (!shown)
        list.append(
          el(
            'p',
            'No matching models. Create/load a provider session or explicitly refresh; no catalogue is invented.',
          ),
        );
      if (shown > 100) list.append(el('p', 'First 100 matches; narrow the search.'));
    };
    search.oninput = () => {
      this.search = search.value;
      render();
    };
    this.body.append(search, list);
    render();
  }
  private statistics() {
    const group = el('select');
    group.setAttribute('aria-label', 'Statistics grouping');
    for (const v of ['model', 'day', 'week', 'month', 'session']) {
      const option = el('option', v);
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
    model.placeholder = 'Exact model ID (all if empty)';
    model.value = this.filter.model ?? '';
    model.setAttribute('aria-label', 'Usage model filter');
    const session = el('select');
    session.setAttribute('aria-label', 'Usage session filter');
    const all = el('option', 'All Workbench sessions');
    all.value = '';
    session.append(all);
    for (const s of this.sessions) {
      const option = el('option', `#${s.created_seq} ${s.title ?? s.id}`);
      option.value = s.id;
      session.append(option);
    }
    session.value = this.filter.session ?? '';
    this.body.append(
      field('Group', group),
      field('From (UTC)', from),
      field('To (UTC inclusive)', to),
      model,
      session,
      button('Apply usage filters', () => {
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
    const rows = [...(this.data?.totals ? [this.data.totals] : []), ...(this.data?.groups ?? [])];
    const table = el('table');
    const head = el('tr');
    for (const name of [
      'Group',
      'Calls',
      'Input',
      'Output',
      'Cache read',
      'Cache write',
      'USD estimate',
      'Missing usage/cache/unpriced',
    ])
      head.append(el('th', name));
    table.append(head);
    const max = Math.max(
      0.000001,
      ...rows.filter((r) => r.key !== 'total').map((r) => r.estimated_usd),
    );
    for (const r of rows) {
      const tr = el('tr');
      const key = el('td');
      const label =
        r.key === 'total' ? 'Filtered total' : this.sessions.find((s) => s.id === r.key);
      const text =
        r.key === 'total'
          ? 'Filtered total'
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
          r.calls,
          r.input,
          r.output,
          r.cache_read,
          r.cache_write,
          r.estimated_usd.toFixed(6),
          `${r.missing}/${r.cache_missing}/${r.unpriced}`,
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
    this.body.append(
      table,
      el(
        'p',
        'Only Workbench-accepted calls are recorded; native-load and inherited fork history are not backfilled. NULL/missing usage is counted separately, not presented as a known zero. Inference and isolated title calls are included once each.',
      ),
    );
    if (this.data?.next_cursor)
      this.body.append(button('Next statistics page', () => this.load(this.data!.next_cursor!)));
  }
}
