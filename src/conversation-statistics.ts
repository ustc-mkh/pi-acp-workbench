import type { Memento } from 'vscode';
import { validPriceModel, type PricePreferences, type PriceOverrides } from './price-preferences';
import type { Agent } from './remote-agent';
import type { ChatState, Snapshot } from './shared';
import type { ClientOperations } from './conversation-history';
import { HARNESSES, type HarnessId } from './harness';
import {
  mergeUsage,
  validPrice,
  priceFor,
  type Inspection,
  type Statistics,
  type Price,
  type UsageRecord,
} from './telemetry';

interface StatisticsContext {
  agent?: Pick<Agent, 'harness' | 'info' | 'request'>;
  state: ChatState;
  harness: HarnessId;
  conversationId?: string;
  retained: boolean;
}
function metadataDeadline<T>(request: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('用量读取超时，请稍后刷新。')), 10000);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
/** Usage pagination, attribution and pricing, isolated from webview/session transitions. */
export class ConversationStatistics {
  value: Statistics;
  pending?: Promise<void>;
  private pendingForce = false;
  private priceStorageNote?: string;
  private withPriceNote(note?: string) {
    return [note, this.priceStorageNote].filter(Boolean).join('\n') || undefined;
  }
  private metadataHistory?: Snapshot[];
  private overrides: Record<string, Price>;
  private modelPrices: Record<string, Price> = {};
  constructor(
    private storage: Memento,
    private persistence: ClientOperations,
    private current: () => StatisticsContext,
    private contextWindow: (value: number) => void,
    private changed: () => void,
    private pricePreferences?: PricePreferences,
  ) {
    this.overrides = {};
    this.value = {
      records: mergeUsage([], storage.get('usageRecords', [])),
      prices: {},
      titles: storage.get('usageTitles', {}),
      sessionNumbers: storage.get('usageSessionNumbers', {}),
      available: false,
    };
    // Legacy bare prices need the already loaded records when expanding around
    // a qualified model reset, including cold sessions with no model catalogue.
    this.value.prices = this.prices();
  }
  reset(harness: HarnessId) {
    this.value = {
      ...this.value,
      available: false,
      models: [],
      note: this.withPriceNote(harness === 'pi' ? undefined : HARNESSES[harness].note),
    };
  }
  sessionMetadata(history: Snapshot[]) {
    if (history === this.metadataHistory) return;
    this.metadataHistory = history;
    const titles = { ...this.value.titles },
      sessionNumbers = { ...this.value.sessionNumbers };
    for (const item of history) {
      if (item.title) titles[item.id] = item.title;
      if (item.sessionNumber) sessionNumbers[item.id] = item.sessionNumber;
    }
    if (
      JSON.stringify([titles, sessionNumbers]) !==
      JSON.stringify([this.value.titles, this.value.sessionNumbers])
    )
      this.value = { ...this.value, titles, sessionNumbers };
  }
  models(state: ChatState) {
    if (state.status !== 'ready' && state.status !== 'busy') return;
    const models =
      state.configs
        ?.filter((c) => c.category === 'model' || c.id === 'model')
        .flatMap((c) =>
          c.type === 'select' ? c.options.flatMap((o) => ('options' in o ? o.options : [o])) : [],
        )
        .map((o) => ({ id: o.value, name: o.name })) || [];
    if (JSON.stringify(models) !== JSON.stringify(this.value.models))
      this.value = { ...this.value, models };
  }
  forget(id?: string) {
    const titles = { ...this.value.titles };
    if (id) delete titles[id];
    this.value = { ...this.value, titles: id ? titles : {} };
  }
  async persistTitles() {
    await this.storage.update('usageTitles', this.value.titles);
    await this.storage.update('usageSessionNumbers', this.value.sessionNumbers || {});
  }
  private legacyOverrides(): PriceOverrides {
    const legacy: PriceOverrides = Object.fromEntries(
      Object.entries(this.storage.get<Record<string, unknown>>('prices', {})).filter(
        ([model, value]) => validPriceModel(model) && validPrice(value),
      ),
    ) as Record<string, Price>;
    for (const key of this.storage.keys()) {
      if (!key.startsWith('price:')) continue;
      const model = key.slice('price:'.length);
      const value = this.storage.get<Price | null>(key);
      if (validPriceModel(model) && (value === null || validPrice(value))) legacy[model] = value;
    }
    return legacy;
  }
  private readOverrides() {
    const legacy = this.legacyOverrides();
    let raw: PriceOverrides;
    try {
      raw = this.pricePreferences?.read(legacy) ?? legacy;
      this.priceStorageNote = undefined;
    } catch (error) {
      // The display path must degrade: a corrupt/unreadable overrides file
      // falls back to the Memento copy instead of breaking activation or the
      // statistics view. Writes stay fail-closed — set() re-reads inside the
      // lock and aborts before replacing the file, so this catch can never
      // mask a clobbered write.
      raw = { ...legacy };
      // MUTATE note — never `this.value = {...}` here: this runs inside
      // `this.value.prices = this.prices()` where the assignment target was
      // already bound, so replacing the object would drop the computed prices
      // (and the note) onto a stale object.
      this.priceStorageNote = error instanceof Error ? error.message : String(error);
      if (this.value) this.value.note = this.priceStorageNote;
    }
    const overrides: Record<string, Price> = {};
    const resets = new Set<string>();
    for (const [model, value] of Object.entries(raw)) {
      if (value === null) resets.add(model);
      else overrides[model] = value;
    }
    // Apply bare resets first, independent of storage key enumeration order.
    for (const model of resets) delete overrides[model];
    // Tombstones mask legacy values without rewriting a shared aggregate key.
    for (const model of resets) {
      const bare = model.split('/').slice(1).join('/');
      const legacy = overrides[bare];
      if (legacy && priceFor(model, { [bare]: legacy })) {
        const known = new Set([
          ...Object.keys(this.modelPrices),
          ...Object.keys(overrides),
          ...(this.value?.models || []).map((m) => m.id),
          ...(this.value?.records || []).map((r) => r.model),
        ]);
        for (const other of known)
          if (
            !resets.has(other) &&
            !Object.hasOwn(overrides, other) &&
            priceFor(other, { [bare]: legacy })
          )
            overrides[other] = legacy;
        delete overrides[bare];
      }
      delete overrides[model];
    }
    return overrides;
  }
  private prices() {
    this.overrides = this.readOverrides();
    const prices = { ...this.modelPrices, ...this.overrides };
    // Older user settings can use a bare model ID. They still outrank Pi's defaults.
    for (const model of Object.keys(this.modelPrices)) {
      const override = priceFor(model, this.overrides);
      if (override) prices[model] = override;
    }
    return prices;
  }
  async setPrice(model: string, price?: Price) {
    if (typeof model !== 'string' || !validPriceModel(model)) throw new Error('模型标识无效。');
    if (price !== undefined && !validPrice(price)) throw new Error('价格必须为非负有限数值。');
    if (!this.pricePreferences) throw new Error('模型价格共享存储尚未配置。');
    // Memento writes the whole extension cache, even for separate model keys.
    // Only a locked file transaction can safely merge another window's write.
    await this.pricePreferences.set(
      model,
      price === undefined
        ? null
        : {
            input: price.input,
            output: price.output,
            cacheRead: price.cacheRead,
            cacheWrite: price.cacheWrite,
            source: '用户设置',
          },
      this.legacyOverrides(),
    );
    this.value = {
      ...this.value,
      prices: this.prices(),
    };
    // Cold sessions have no live model catalogue until explicitly inspected.
    if (price === undefined) await this.refresh(this.current().state.status !== 'busy');
  }
  async record(records: UsageRecord[]) {
    const { state, conversationId, retained } = this.current(),
      titles = { ...this.value.titles };
    const merged = mergeUsage(
      this.value.records,
      records.map((r) => ({ ...r, sessionId: conversationId || r.sessionId })),
    );
    const first = state.entries.find((e) => e.role === 'user');
    if (state.sessionId) {
      const id = conversationId || state.sessionId;
      if (retained && state.sessionTitle) titles[id] = state.sessionTitle;
      else if (retained && first?.role === 'user') titles[id] = first.text.slice(0, 32);
      else delete titles[id];
    }
    this.value = { ...this.value, records: merged, titles };
    await this.persistence.enqueue(async () => {
      await this.storage.update('usageRecords', this.value.records);
      await this.persistTitles();
    });
  }
  async refresh(settledTurn = false): Promise<void> {
    if (this.pending) {
      const forced = this.pendingForce;
      await this.pending;
      if (!settledTurn || forced) return;
      // An earlier cached/cold read must not swallow an explicit refresh.
      return this.refresh(true);
    }
    const { agent, state, harness } = this.current(),
      sessionId = state.sessionId;
    const meta = agent?.info?.agentCapabilities?._meta?.['pi-workbench'] as
      | { version?: number }
      | undefined;
    const service = agent?.info?.agentCapabilities?._meta?.['session-service'] as
      | { usageInspection?: boolean }
      | undefined;
    this.value = {
      ...this.value,
      available:
        (agent?.harness === 'pi' && meta?.version === 1) || service?.usageInspection === true,
      note: harness !== 'pi' ? this.withPriceNote(HARNESSES[harness].note) : this.value.note,
    };
    if (!agent || !sessionId || !this.value.available || (state.status === 'busy' && !settledTurn))
      return;
    const current = () => {
      const now = this.current();
      return now.agent === agent && now.state === state && now.state.sessionId === sessionId;
    };
    this.pendingForce = settledTurn;
    this.pending = (async () => {
      try {
        let cursor: number | undefined;
        const records: UsageRecord[] = [];
        let note: string | undefined;
        do {
          const data = await metadataDeadline(
            agent.request<Inspection>('_pi_workbench/inspect', {
              sessionId,
              cursor,
              force: settledTurn,
            }),
          );
          if (!current()) return;
          records.push(...(data.records || []));
          if (!cursor) {
            note = data.note;
            if (data.modelContexts !== undefined)
              state.modelContexts = Object.fromEntries(
                Object.entries(data.modelContexts).filter(
                  ([key, value]) =>
                    !['__proto__', 'constructor', 'prototype'].includes(key) &&
                    Number.isSafeInteger(value) &&
                    value > 0,
                ),
              );
            if (data.contextWindow && Number.isFinite(data.contextWindow) && data.contextWindow > 0)
              this.contextWindow(data.contextWindow);
            if (data.prices !== undefined) {
              this.modelPrices = Object.fromEntries(
                Object.entries(data.prices).filter(
                  ([key, value]) =>
                    validPrice(value) && !['__proto__', 'constructor', 'prototype'].includes(key),
                ),
              );
              // Omission is unknown; an explicitly empty price map clears Pi defaults.
            }
            this.value = {
              ...this.value,
              prices: this.prices(),
            };
          }
          if (
            data.cursor !== undefined &&
            (!Number.isSafeInteger(data.cursor) || data.cursor <= (cursor || 0))
          )
            throw new Error('Invalid usage pagination');
          cursor = data.cursor;
        } while (cursor !== undefined);
        await this.record(records);
        if (current()) this.value = { ...this.value, note: this.withPriceNote(note) };
      } catch (error) {
        if (current())
          this.value = {
            ...this.value,
            note: this.withPriceNote(
              `用量读取未完成：${error instanceof Error ? error.message : String(error)}`,
            ),
          };
      } finally {
        this.changed();
      }
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
      this.pendingForce = false;
    }
  }
}
