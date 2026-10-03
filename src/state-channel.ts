import type { ChatState, Entry } from './shared';

type Fields = Omit<ChatState, 'entries'>;
export type StateMessage =
  | { type: 'state'; state: ChatState; revision: number }
  | { type: 'statePatch'; revision: number; fields: Partial<Fields>; unset: (keyof Fields)[]; entries: Entry[]; order?: string[] };

/** Keep large immutable history/image payloads off the streaming transport. */
export class StateEncoder {
  private revision = 0;
  private session?: string;
  private fields = new Map<string, string | undefined>();
  private entries = new Map<string, string>();
  reset() { this.revision = 0; this.fields.clear(); this.entries.clear(); }
  encode(state: ChatState): StateMessage {
    if (state.sessionId !== this.session) this.reset();
    this.session = state.sessionId;
    const { entries, ...fields } = state;
    const nextFields = new Map(Object.entries(fields).map(([key, value]) => [key, JSON.stringify(value)]));
    const nextEntries = new Map(entries.map(entry => [entry.id, JSON.stringify(entry)]));
    const revision = ++this.revision;
    let message: StateMessage;
    if (revision === 1) message = { type: 'state', state, revision };
    else {
      const changed = Object.fromEntries(Object.entries(fields).filter(([key]) => nextFields.get(key) !== this.fields.get(key)));
      const unset = [...this.fields.keys()].filter(key => !nextFields.has(key) || nextFields.get(key) === undefined) as (keyof Fields)[];
      const order = [...nextEntries.keys()], previousOrder = [...this.entries.keys()];
      message = { type: 'statePatch', revision, fields: changed, unset,
        entries: entries.filter(entry => nextEntries.get(entry.id) !== this.entries.get(entry.id)),
        ...(order.length !== this.entries.size || order.some((id, i) => id !== previousOrder[i]) ? { order } : {}) };
    }
    this.fields = nextFields; this.entries = nextEntries;
    return message;
  }
}

/** Preserve unchanged entry identities so the renderer can skip serialization. */
export function applyStatePatch(state: ChatState, patch: Extract<StateMessage, {type:'statePatch'}>): ChatState {
  const next = { ...state, ...patch.fields };
  for (const key of patch.unset) delete next[key];
  const changed = new Map(patch.entries.map(entry => [entry.id, entry]));
  if (patch.order) {
    const entries = new Map(state.entries.map(entry => [entry.id, entry]));
    for (const [id, entry] of changed) entries.set(id, entry);
    next.entries = patch.order.map(id => entries.get(id)!);
  } else next.entries = state.entries.map(entry => changed.get(entry.id) || entry);
  return next;
}
