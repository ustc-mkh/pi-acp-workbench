import type * as acp from '@agentclientprotocol/sdk';
import type { ChildProcess } from 'node:child_process';
import type { NativeEntry, NativeMessage } from './native-branch';
import type { Price } from './telemetry';

/** Minimal contract for the pinned JS adapter's runtime injection points. */
export interface PiModel {
  api?: string;
  provider?: string;
  id?: string;
  contextWindow?: number;
  cost?: Price;
}
export interface PiState {
  model?: PiModel;
  sessionId?: string;
  sessionFile?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
}
export interface PiProcess {
  child: ChildProcess;
  dispose(): void;
  prompt(text: string): Promise<void>;
  request(command: {
    type: 'get_commands';
  }): Promise<
    { success: true; data: { commands: { name: string }[] } } | { success: false; error?: string }
  >;
  request(command: {
    type: 'get_entries';
  }): Promise<
    | { success: true; data: { entries: NativeEntry[]; leafId: string | null } }
    | { success: false; error?: string }
  >;
  getState(): Promise<PiState>;
  getMessages(): Promise<{ messages?: NativeMessage[] }>;
  getAvailableModels(): Promise<{ models?: PiModel[] }>;
}
export interface PiProcessFactory {
  spawn(options: {
    cwd: string;
    sessionPath: string;
    piCommand?: string;
    workbenchFork: string;
    workbenchForkSessionDir: string;
  }): Promise<PiProcess>;
}
export interface PiSession {
  sessionId: string;
  cwd: string;
  proc: PiProcess;
  pendingTurn?: unknown;
  cancelRequested: boolean;
  publishContextUsage(): Promise<void>;
  wasCancelRequested(): boolean;
}
export interface PiAgent {
  sessions: Map<string, PiSession>;
  store: { upsert(session: { sessionId: string; cwd: string; sessionFile: string }): void };
  restoreSession(id: string): Promise<PiSession>;
  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse>;
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
  dispose(): void;
}
export interface WorkbenchParams {
  sessionId: string;
  entryId?: string;
  hash?: string;
  cursor?: number;
}
