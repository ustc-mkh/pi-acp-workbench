import type { Agent } from './remote-agent';
import { initialState } from './state';

export interface ConversationSnapshot {
  state: ReturnType<typeof initialState>;
  agent?: Agent;
  cwd: string;
  contextWindow?: number;
  conversationId?: string;
  generation: number;
  contextAbort?: AbortController;
}

/** Owns the lifetime of the selected conversation; identity changes are atomic. */
export class ActiveConversation {
  private value: ConversationSnapshot = { state: initialState(), cwd: '', generation: 0 };
  get state() {
    return this.value.state;
  }
  get agent() {
    return this.value.agent;
  }
  get cwd() {
    return this.value.cwd;
  }
  get contextWindow() {
    return this.value.contextWindow;
  }
  get conversationId() {
    return this.value.conversationId;
  }
  get generation() {
    return this.value.generation;
  }
  get contextAbort() {
    return this.value.contextAbort;
  }
  replace(snapshot: Partial<ConversationSnapshot>) {
    this.value = { ...this.value, ...snapshot };
  }
  reset(state: Partial<ConversationSnapshot['state']> = {}) {
    this.value.contextAbort?.abort();
    this.value.agent?.dispose();
    this.value = {
      state: { ...initialState(), ...state },
      cwd: '',
      generation: this.value.generation + 1,
    };
  }
}
