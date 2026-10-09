import type { UiMessage, ChatState } from './shared';
import type { UiPolicy } from './ui-dispatch';
import type { HarnessId } from './harness';

export interface RequestGate {
  type: UiMessage['type'];
  pending: boolean;
  previous?: RequestGate;
  previousOperation?: Operation;
}
type RequestContext = Pick<ChatState, 'status' | 'sessionId'> & { harness: HarnessId };

type Operation =
  | { kind: 'idle' }
  | { kind: 'transition'; replaying: boolean }
  | { kind: 'turn'; step: 'preparing' | 'prompting' | 'finishing'; cancelled: boolean }
  | { kind: 'disposed' };
/** One active UI operation, with cancellation confined to a live turn. */
export class ConversationLifecycle {
  private operation: Operation = { kind: 'idle' };
  private request?: RequestGate;
  acquire(
    message: UiMessage,
    policy: UiPolicy,
    context: RequestContext,
  ): RequestGate | false | undefined {
    if (this.disposed) return false;
    if (!policy.gated) return undefined;
    if (
      context.status === 'busy' &&
      ((message.type === 'resume' && message.id === context.sessionId) ||
        (message.type === 'switchHarness' && message.harness === context.harness))
    )
      return false;
    if (
      this.request &&
      !(policy.navigation && this.request.type === 'send' && context.status === 'busy')
    )
      return false;
    const gate: RequestGate = {
      type: message.type,
      pending: true,
      previous: this.request,
      previousOperation: this.request ? this.operation : undefined,
    };
    this.request = gate;
    return gate;
  }
  allowed(policy: UiPolicy, context: RequestContext) {
    return (
      !this.disposed &&
      (!policy.gated ||
        (!this.transitioning &&
          context.status !== 'connecting' &&
          (context.status !== 'busy' || policy.navigation === true)))
    );
  }
  release(gate: RequestGate | undefined, sameGeneration: boolean) {
    if (!gate) return;
    gate.pending = false;
    if (this.request === gate) {
      const restore = sameGeneration && gate.previous?.pending;
      this.request = restore ? gate.previous : undefined;
      if (restore && this.operation.kind === 'idle' && gate.previousOperation?.kind === 'turn')
        this.operation = gate.previousOperation;
    }
  }
  get disposed() {
    return this.operation.kind === 'disposed';
  }
  get transitioning() {
    return this.operation.kind === 'transition';
  }
  get replaying() {
    return this.operation.kind === 'transition' && this.operation.replaying;
  }
  set replaying(value: boolean) {
    if (this.operation.kind === 'transition') this.operation.replaying = value;
  }
  transition(value: boolean) {
    if (this.disposed) return;
    this.operation = value ? { kind: 'transition', replaying: false } : { kind: 'idle' };
  }
  beginTurn() {
    if (!this.disposed) this.operation = { kind: 'turn', step: 'preparing', cancelled: false };
  }
  private get activeTurn() {
    if (this.disposed) return undefined;
    if (this.operation.kind === 'turn') return this.operation;
    const previous = this.request?.previousOperation;
    return previous?.kind === 'turn' ? previous : undefined;
  }
  get cancelled() {
    return this.activeTurn?.cancelled ?? false;
  }
  cancel() {
    const turn = this.activeTurn;
    if (turn) turn.cancelled = true;
  }
  get prompting() {
    return this.activeTurn?.step === 'prompting';
  }
  prompt(value: boolean) {
    const turn = this.activeTurn;
    if (turn) turn.step = value ? 'prompting' : 'finishing';
  }
  finishTurn() {
    if (this.operation.kind === 'turn') this.operation = { kind: 'idle' };
    if (this.request?.previousOperation?.kind === 'turn')
      this.request.previousOperation = { kind: 'idle' };
  }
  dispose() {
    this.operation = { kind: 'disposed' };
  }
}
