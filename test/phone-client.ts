// Transport-only phone fixture. No workspace policy, relay, persistence or execution engine.
import { SessionClient } from '../src/session-wire';
import type { ServiceState } from '../src/session-protocol';
import type { Snapshot, ChatState } from '../src/shared';
type Listener = { permission(value: ChatState['permissions'][number]): void };
export class PhoneClient {
  private client: SessionClient;
  private listeners = new Map<string, Listener>();
  constructor(
    private cwd: string,
    socket: string,
  ) {
    this.client = new SessionClient(socket, (event) => {
      if (event.type === 'state')
        for (const p of event.permissions ?? [])
          this.listeners.get(event.snapshot.id)?.permission(p);
    });
  }
  list() {
    return this.client.call<Snapshot[]>('list');
  }
  create(cwd = this.cwd) {
    return this.client.call<Snapshot>('create', { cwd }, undefined, 0);
  }
  async history(sessionId: string) {
    return (await this.status(sessionId)).snapshot.entries;
  }
  status(sessionId: string) {
    return this.client.call<ServiceState>('state', { sessionId });
  }
  cancel(sessionId: string) {
    return this.client.call<boolean>('cancel', { sessionId });
  }
  permission(sessionId: string, permissionId: string, optionId?: string) {
    return this.client.call<boolean>('permission', { sessionId, permissionId, optionId });
  }
  async run(sessionId: string, text: string, listener: Listener) {
    this.listeners.set(sessionId, listener);
    try {
      await this.client.watch(sessionId);
      const { stopReason } = await this.client.call<{ stopReason: string }>(
        'prompt',
        { sessionId, prompt: [{ type: 'text', text }], source: 'telegram' },
        undefined,
        0,
      );
      return {
        status:
          stopReason === 'end_turn'
            ? 'completed'
            : stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed',
      };
    } finally {
      this.listeners.delete(sessionId);
      await this.client.watch(sessionId, false).catch(() => {});
    }
  }
  dispose() {
    this.client.dispose();
  }
}
