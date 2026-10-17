import { validPriceModel, type PricePreferences, type PriceOverrides } from './price-preferences';
import type { Agent } from './remote-agent';
import type { ChatState, Snapshot } from './shared';
import type { ClientOperations } from './conversation-history';
import { HARNESSES, type HarnessId } from './harness';
import type { UsageStorage } from './usage-storage';
import {
  mergeUsage,
  validPrice,
  priceFor,
  priceOverrideVersion,
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
  private pendingContext?: Pick<StatisticsContext, 'agent' | 'state'> & { sessionId?: string };
  private priceStorageNote?: string;
  private withPriceNote(note?: string) {
    return [note, this.priceStorageNote].filter(Boolean).join('\n') || undefined;
  }
  private metadataHistory?: Snapshot[];
  private persistedTitles: Record<string, string>;
  private persistedSessionNumbers: Record<string, number>;
  private overrides: Record<string, Price>;
  private lastOverrides: PriceOverrides = {};
  private modelPrices: Record<string, Price> = {};
  constructor(
    private storage: UsageStorage,
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
    this.persistedTitles = { ...this.value.titles };
    this.persistedSessionNumbers = { ...this.value.sessionNumbers };
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
    const patch = <T extends string | number>(
      before: Record<string, T>,
      after: Record<string, T>,
    ) => {
      const changes: Record<string, T | null> = {};
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!Object.hasOwn(after, id)) changes[id] = null;
        else if (before[id] !== after[id]) changes[id] = after[id];
      }
      return changes;
    };
    if (!this.storage.patch) {
      await this.storage.update('usageTitles', this.value.titles);
      await this.storage.update('usageSessionNumbers', this.value.sessionNumbers || {});
      return;
    }
    const titles = await this.storage.patch(
      'usageTitles',
      patch(this.persistedTitles, this.value.titles),
    );
    const numbers = await this.storage.patch(
      'usageSessionNumbers',
      patch(this.persistedSessionNumbers, this.value.sessionNumbers || {}),
    );
    this.persistedTitles = titles as Record<string, string>;
    this.persistedSessionNumbers = numbers as Record<string, number>;
    this.value = {
      ...this.value,
      titles: this.persistedTitles,
      sessionNumbers: this.persistedSessionNumbers,
    };
  }
  private readOverrides() {
    let raw: PriceOverrides;
    try {
      raw = this.pricePreferences?.read({}) ?? {};
      this.lastOverrides = raw;
      if (this.priceStorageNote && this.value.note)
        this.value.note = this.value.note.replace(this.priceStorageNote, '').trim() || undefined;
      this.priceStorageNote = undefined;
    } catch (error) {
      // Retain the last successfully read global overrides on transient read
      // failures. Never replace them with workspace data or a zero/default price.
      // Writes remain fail-closed and the error stays visible.
      raw = this.lastOverrides;
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
    this.value.priceVersions = Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(this.lastOverrides),
          ...Object.keys(this.modelPrices),
          ...(this.value.models || []).map((m) => m.id),
        ]),
      ].map((model) => [model, priceOverrideVersion(model, this.lastOverrides)]),
    );
    return prices;
  }
  async setPrice(model: string, price?: Price, expectedVersion?: string) {
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
      {},
      expectedVersion,
    );
    this.value = {
      ...this.value,
      prices: this.prices(),
      priceVersions: this.value.priceVersions,
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
    // Global prices can be changed by another window even without a connected
    // agent. Re-read before deciding whether inspection is available.
    this.value.prices = this.prices();
    if (this.pending) {
      const requested = this.current(),
        sessionId = requested.state.sessionId;
      const same =
        this.pendingContext?.agent === requested.agent &&
        this.pendingContext?.state === requested.state &&
        this.pendingContext?.sessionId === sessionId;
      const forced = this.pendingForce;
      await this.pending;
      const now = this.current();
      if (
        now.agent !== requested.agent ||
        now.state !== requested.state ||
        now.state.sessionId !== sessionId
      )
        return;
      if (same && (!settledTurn || forced)) return;
      // A read belonging to another session or a cached read cannot swallow
      // an explicit page-open refresh.
      return this.refresh(settledTurn);
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
    if (!agent || !sessionId || !this.value.available) return;
    const current = () => {
      const now = this.current();
      return now.agent === agent && now.state === state && now.state.sessionId === sessionId;
    };
    this.pendingForce = settledTurn;
    this.pendingContext = { agent, state, sessionId };
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
              priceVersions: this.value.priceVersions,
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
      this.pendingContext = undefined;
    }
  }
}
