import type { ChatState, Snapshot } from './shared';

// Client/config DTOs only. Runtime command validation belongs to the Rust service.
export interface ServiceConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  maxWorkers: number;
  idleMs: number;
}
export interface ServiceState {
  snapshot: Snapshot;
  busy: boolean;
  permissions: ChatState['permissions'];
  commands: ChatState['commands'];
  error?: string;
}
