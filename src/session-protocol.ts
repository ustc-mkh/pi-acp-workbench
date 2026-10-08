export type {
  AgentRequest,
  ServiceCommand,
  ServiceState,
  ErrorCode,
} from './session-protocol.generated';

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
