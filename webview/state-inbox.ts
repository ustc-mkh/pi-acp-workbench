import { applyStatePatch, type StateMessage } from '../src/state-channel';
import type { ChatState } from '../src/shared';
/** Owns the host/webview delta baseline, independently from DOM orchestration. */
export class StateInbox {
  private state?: ChatState;
  private revision = 0;
  receive(message: StateMessage): { state: ChatState; switched: boolean } | 'resync' {
    const previousSession = this.state?.sessionId;
    if (message.type === 'statePatch') {
      if (!this.state || message.revision !== this.revision + 1) return 'resync';
      this.state = applyStatePatch(this.state, message);
    } else {
      this.state = message.state;
    }
    this.revision = message.revision || 0;
    return { state: this.state, switched: previousSession !== this.state.sessionId };
  }
}
