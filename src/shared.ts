import type { HarnessId } from './harness';
import type { NativeBranchTarget } from './native-branch';
import type { Statistics, Price } from './telemetry';
import type { TurnDiff } from './turn-diff';
import type * as acp from '@agentclientprotocol/sdk';
// Entries are replaced on update; the state channel uses their identity for change tracking.
export type Entry = Readonly<
  | {
      id: string;
      role: 'user' | 'assistant' | 'thought' | 'notice';
      text: string;
      messageId?: string | null;
      contextBlocks?: acp.ContentBlock[];
    }
  | { id: string; role: 'tool'; tool: acp.ToolCall; terminal?: TerminalOutput }
  | { id: string; role: 'diff'; text: string; diff: TurnDiff }
>;
export interface OutputImageReply {
  type: 'outputImage';
  id: string;
  image?: import('./images').PastedImage;
  error?: string;
}
export type Attachment =
  | { kind?: 'text'; id: string; name: string; uri: string; text: string }
  | { kind: 'image'; id: string; name: string; mimeType: string; data: string };
export interface TerminalOutput {
  id: string;
  output: string;
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  truncated?: boolean;
}
export interface ContextUsage {
  used: number | null;
  size: number;
}
export interface Snapshot {
  /** Live list metadata only; absent in persisted snapshots and older daemons. */
  busy?: boolean;
  commands?: acp.AvailableCommand[];
  nativeForks?: Record<string, NativeBranchTarget>;
  harness?: HarnessId;
  sessionNumber?: number;
  revision?: string;
  id: string;
  cwd: string;
  title: string;
  updated: number;
  entries: Entry[];
  stored?: boolean;
  conversationId?: string;
  contextWindow?: number;
  usage?: ContextUsage;
  contextComplete?: boolean;
  configs?: acp.SessionConfigOption[];
  modes?: acp.SessionModeState;
}
export interface ChatState {
  status: 'disconnected' | 'connecting' | 'ready' | 'busy';
  harness?: HarnessId;
  connectionAttempted?: boolean;
  readOnly?: boolean;
  sessionId?: string;
  sessionNumber?: number;
  agent?: string;
  error?: string;
  entries: Entry[];
  attachments: Attachment[];
  modes?: acp.SessionModeState;
  configs?: acp.SessionConfigOption[];
  commands: acp.AvailableCommand[];
  plan: acp.PlanEntry[];
  usage?: ContextUsage;
  visibleModels?: string[];
  modelContexts?: Record<string, number>;
  history: Omit<Snapshot, 'entries'>[];
  permissions: { id: string; request: acp.RequestPermissionRequest }[];
  showThoughts: boolean;
  preview: boolean;
  contextComplete?: boolean;
  nativeForks?: Record<string, NativeBranchTarget>;
  statistics?: Statistics;
  contextOperation?: { kind: 'fork' };
}
export type UiMessage =
  | {
      type:
        | 'ready'
        | 'connect'
        | 'new'
        | 'cancel'
        | 'attach'
        | 'clearHistory'
        | 'login'
        | 'logs'
        | 'preview'
        | 'export'
        | 'refreshStatistics'
        | 'cancelContext'
        | 'releaseSession'
        | 'refreshHistory';
    }
  | {
      type: 'attachImages';
      harness?: HarnessId;
      sessionId?: string;
      images: import('./images').PastedImage[];
    }
  | { type: 'attachmentError'; harness?: HarnessId; sessionId?: string; error: string }
  | { type: 'readOutputImage'; id: string; url: string; harness: HarnessId; sessionId?: string }
  | { type: 'switchHarness'; harness: HarnessId }
  | { type: 'setPrice'; model: string; price?: Price }
  | { type: 'send'; text: string }
  | { type: 'dismissError'; error: string }
  | { type: 'permission'; id: string; optionId?: string }
  | { type: 'mode'; value: string }
  | { type: 'config'; id: string; value: string }
  | { type: 'setVisibleModels'; harness: HarnessId; models: string[] | null }
  | { type: 'refreshModelContexts'; harness: HarnessId; sessionId: string }
  | {
      type: 'setModelContext';
      harness: HarnessId;
      sessionId: string;
      model: string;
      contextWindow: number | null;
    }
  | { type: 'resume' | 'removeAttachment' | 'deleteHistory'; id: string }
  | { type: 'branchMessage'; id: string; sessionId: string }
  | { type: 'diff'; id: string; index: number }
  | { type: 'open'; url: string; line?: number };
