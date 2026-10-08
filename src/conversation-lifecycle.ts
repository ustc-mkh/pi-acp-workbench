type Operation =
  | { kind: 'idle' }
  | { kind: 'transition'; replaying: boolean }
  | { kind: 'turn'; step: 'preparing' | 'prompting' | 'finishing'; cancelled: boolean }
  | { kind: 'disposed' };
/** One active UI operation, with cancellation confined to a live turn. */
export class ConversationLifecycle {
  private operation: Operation = { kind: 'idle' };
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
  get cancelled() {
    return this.operation.kind === 'turn' && this.operation.cancelled;
  }
  cancel() {
    if (this.operation.kind === 'turn') this.operation.cancelled = true;
  }
  get prompting() {
    return this.operation.kind === 'turn' && this.operation.step === 'prompting';
  }
  prompt(value: boolean) {
    if (this.operation.kind === 'turn') this.operation.step = value ? 'prompting' : 'finishing';
  }
  finishTurn() {
    if (this.operation.kind === 'turn') this.operation = { kind: 'idle' };
  }
  dispose() {
    this.operation = { kind: 'disposed' };
  }
}
