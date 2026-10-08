import type { Memento } from 'vscode';
import type { Agent } from './remote-agent';
import type { ChatState } from './shared';
import type { ClientOperations } from './conversation-history';
import { HARNESSES, type HarnessId } from './harness';
import { presetPrices } from './prices';
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
  agent?: Agent;
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
  private overrides: Record<string, Price>;
  private modelPrices: Record<string, Price> = {};
  constructor(
    private storage: Memento,
    private persistence: ClientOperations,
    private current: () => StatisticsContext,
    private contextWindow: (value: number) => void,
    private changed: () => void,
  ) {
    this.overrides = storage.get('prices', {});
    this.value = {
      records: mergeUsage([], storage.get('usageRecords', [])),
      prices: { ...presetPrices, ...this.overrides },
      titles: storage.get('usageTitles', {}),
      available: false,
    };
  }
  reset(harness: HarnessId) {
    this.value = {
      ...this.value,
      available: false,
      models: [],
      note: harness === 'pi' ? undefined : HARNESSES[harness].note,
    };
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
  persistTitles() {
    return this.storage.update('usageTitles', this.value.titles);
  }
  async setPrice(model: string, price?: Price) {
    if (
      typeof model !== 'string' ||
      !model.trim() ||
      model.length > 300 ||
      ['__proto__', 'constructor', 'prototype'].includes(model)
    )
      throw new Error('模型标识无效。');
    if (price === undefined) delete this.overrides[model];
    else {
      if (!validPrice(price)) throw new Error('价格必须为非负有限数值。');
      this.overrides[model] = {
        input: price.input,
        output: price.output,
        cacheRead: price.cacheRead,
        cacheWrite: price.cacheWrite,
        source: '用户设置',
      };
    }
    this.value = {
      ...this.value,
      prices: { ...presetPrices, ...this.modelPrices, ...this.overrides },
    };
    await this.storage.update('prices', this.overrides);
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
      if (retained && first?.role === 'user') titles[id] = first.text.slice(0, 70);
      else delete titles[id];
    }
    this.value = { ...this.value, records: merged, titles };
    await this.persistence.enqueue(async () => {
      await this.storage.update('usageRecords', this.value.records);
      await this.persistTitles();
    });
  }
  async refresh(settledTurn = false) {
    if (this.pending) return this.pending;
    const { agent, state, harness } = this.current(),
      sessionId = state.sessionId;
    const meta = agent?.info?.agentCapabilities?._meta?.['pi-workbench'] as
      | { version?: number }
      | undefined;
    this.value = {
      ...this.value,
      available: agent?.harness === 'pi' && meta?.version === 1,
      note: harness !== 'pi' ? HARNESSES[harness].note : this.value.note,
    };
    if (!agent || !sessionId || !this.value.available || (state.status === 'busy' && !settledTurn))
      return;
    const current = () => {
      const now = this.current();
      return now.agent === agent && now.state === state && now.state.sessionId === sessionId;
    };
    this.pending = (async () => {
      try {
        let cursor: number | undefined;
        const records: UsageRecord[] = [];
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
            if (data.contextWindow && Number.isFinite(data.contextWindow) && data.contextWindow > 0)
              this.contextWindow(data.contextWindow);
            for (const [key, value] of Object.entries(data.prices || {}))
              if (
                validPrice(value) &&
                !priceFor(key, presetPrices) &&
                !['__proto__', 'constructor', 'prototype'].includes(key)
              )
                this.modelPrices[key] = value;
            this.value = {
              ...this.value,
              prices: { ...presetPrices, ...this.modelPrices, ...this.overrides },
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
        if (current()) this.value = { ...this.value, note: undefined };
      } catch (error) {
        if (current())
          this.value = {
            ...this.value,
            note: `用量读取未完成：${error instanceof Error ? error.message : String(error)}`,
          };
      } finally {
        this.changed();
      }
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
}
