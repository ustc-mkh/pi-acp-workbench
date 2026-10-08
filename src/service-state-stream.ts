import type {
  ServiceState,
  ServiceEvent,
  ServiceStateEvent,
  ServiceStatePatch,
} from './session-protocol';
import type { Entry } from './shared';

/** Reconstruct ordered socket deltas without serializing unchanged history entries. */
export class ServiceStateStream {
  private sessions = new Map<string, { revision: number; state: ServiceState }>();
  clear(id?: string) {
    if (id === undefined) this.sessions.clear();
    else this.sessions.delete(id);
  }
  receive(event: ServiceStateEvent | ServiceStatePatch): ServiceStateEvent;
  receive(event: ServiceEvent | ServiceStatePatch): ServiceEvent;
  receive(event: ServiceEvent | ServiceStatePatch): ServiceEvent {
    if (event?.type === 'state') {
      const id = event.snapshot?.id;
      const revision = event.revision;
      if (
        typeof id === 'string' &&
        typeof revision === 'number' &&
        Number.isSafeInteger(revision)
      ) {
        if (!this.sessions.has(id) && this.sessions.size >= 32) throw new Error('会话状态订阅过多');
        this.sessions.set(id, { revision, state: event });
      }
      return event;
    }
    if (event?.type !== 'statePatch') return event;
    const previous = this.sessions.get(event.sessionId);
    if (
      !previous ||
      previous.revision !== event.baseRevision ||
      !Number.isSafeInteger(event.revision) ||
      event.revision <= event.baseRevision ||
      event.state?.snapshot?.id !== event.sessionId ||
      !Array.isArray(event.entries)
    )
      throw new Error('会话状态版本不连续，请重新连接');
    const entries = new Map<string, Entry>(previous.state.snapshot.entries.map((e) => [e.id, e]));
    for (const entry of event.entries) {
      if (!entry || typeof entry.id !== 'string') throw new Error('会话增量条目无效');
      entries.set(entry.id, entry);
    }
    const order: string[] = event.order ?? previous.state.snapshot.entries.map((e) => e.id);
    if (
      !Array.isArray(order) ||
      new Set(order).size !== order.length ||
      order.some((id) => !entries.has(id))
    )
      throw new Error('会话增量顺序无效');
    if (event.order === undefined && entries.size !== order.length)
      throw new Error('会话增量缺少顺序');
    const state: ServiceStateEvent = {
      ...event.state,
      snapshot: { ...event.state.snapshot, entries: order.map((id) => entries.get(id)!) },
      type: 'state',
      revision: event.revision,
    };
    this.sessions.set(event.sessionId, { revision: event.revision, state });
    return state;
  }
}
