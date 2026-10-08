import type * as acp from '@agentclientprotocol/sdk';
import { AgentProcess, type AgentOptions } from './agent';
import { RemoteAgent, type Agent } from './remote-agent';
import type { ServiceState } from './session-protocol';
import type { ChatState } from './shared';
import { SessionCache } from './session-cache';
import { SessionPreferences } from './session-preferences';
import { WorkspaceDiff } from './workspace-diff';

export interface CachedConversation {
  agent: Agent;
  state: ChatState;
  cwd: string;
  contextWindow?: number;
  conversationId?: string;
}
/** Execution differences live here; the provider owns UI and session selection. */
export interface ConversationBackend {
  readonly authoritative: boolean;
  create(options: AgentOptions, state: (value: ServiceState) => void, socket?: string): Agent;
  sync(agent: Agent): Promise<void>;
  beginTurn(cwd: string): Promise<WorkspaceDiff | undefined>;
  answerPermission(agent: Agent, id: string, option?: string): Promise<void>;
}
export class PiServiceBackend implements ConversationBackend {
  readonly authoritative = true;
  create(options: AgentOptions, state: (value: ServiceState) => void, socket?: string) {
    return new RemoteAgent(options, state, socket);
  }
  async sync(agent: Agent) {
    await (agent as RemoteAgent).sync();
  }
  async beginTurn() {
    return undefined;
  }
  async answerPermission(agent: Agent, id: string, option?: string) {
    await (agent as RemoteAgent).permission(id, option);
  }
}
export class LocalAcpBackend implements ConversationBackend {
  readonly authoritative = false;
  readonly sessions = new SessionCache<CachedConversation>();
  readonly preferences = new SessionPreferences();
  private permissions = new Map<string, (response: acp.RequestPermissionResponse) => void>();
  constructor(private factory?: (options: AgentOptions) => Agent) {}
  create(options: AgentOptions) {
    return this.factory ? this.factory(options) : new AgentProcess(options);
  }
  async sync(_agent: Agent) {}
  beginTurn(cwd: string) {
    return WorkspaceDiff.begin(cwd);
  }
  requestPermission(id: string) {
    return new Promise<acp.RequestPermissionResponse>((resolve) =>
      this.permissions.set(id, resolve),
    );
  }
  async answerPermission(_agent: Agent, id: string, option?: string) {
    this.permissions.get(id)?.({
      outcome: option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' },
    });
    this.permissions.delete(id);
  }
  cancelPermissions() {
    for (const resolve of this.permissions.values()) resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
  }
}
