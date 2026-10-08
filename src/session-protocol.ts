import type * as acp from '@agentclientprotocol/sdk';
import type { ServiceState } from './session-protocol.generated';
import type { Entry, Snapshot } from './shared';

export type {
  AgentRequest,
  ServiceCommand,
  ServiceState,
  ErrorCode,
} from './session-protocol.generated';

export type ServiceStateEvent = ServiceState & { type: 'state'; revision?: number };
export type ServiceEvent =
  | ServiceStateEvent
  | { type: 'update'; notification: acp.SessionNotification }
  | { type: 'serviceError'; sessionId: string; error: string };
export interface ServiceStatePatch {
  type: 'statePatch';
  sessionId: string;
  baseRevision: number;
  revision: number;
  state: Omit<ServiceState, 'snapshot'> & { snapshot: Omit<Snapshot, 'entries'> };
  entries: Entry[];
  order?: string[];
}
/** Known socket results; extensions must supply their own response type. */
export interface ServiceResponses {
  hello: acp.InitializeResponse;
  list: Snapshot[];
  create: Snapshot;
  state: ServiceState;
  cancel: boolean;
  remove: void;
  permission: boolean;
  prompt: acp.PromptResponse;
  historyRemove: void;
  _watch: boolean;
}

// Client/config DTOs only. Runtime command validation belongs to the Rust service.
export interface ServiceConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  maxWorkers: number;
  idleMs: number;
  harnesses?: Partial<
    Record<
      'pi' | 'codex' | 'claude',
      { command: string; args?: string[]; env?: Record<string, string> }
    >
  >;
}
