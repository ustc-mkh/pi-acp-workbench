import type { HarnessId } from './harness';
import type { NativeBranchTarget } from './native-branch';
import type { Checkpoint } from './checkpoints';
import type { Statistics, Price } from './telemetry';
import type * as acp from '@agentclientprotocol/sdk';
// Entries are replaced on update; the state channel uses their identity for change tracking.
export type Entry = Readonly<{ id: string; role: 'user' | 'assistant' | 'thought' | 'notice'; text: string; messageId?: string | null; contextBlocks?: acp.ContentBlock[] } | { id: string; role: 'tool'; tool: acp.ToolCall }>;
export type Attachment = {kind?:'text'; id:string;name:string;uri:string;text:string} | {kind:'image';id:string;name:string;mimeType:string;data:string};
export interface Snapshot { nativeForks?: Record<string,NativeBranchTarget>; harness?: HarnessId; sessionNumber?: number; revision?: string; id: string; cwd: string; title: string; updated: number; entries: Entry[]; stored?: boolean; conversationId?: string; checkpoints?: Checkpoint[]; contextWindow?: number; contextComplete?: boolean; contextPending?: boolean; configs?: acp.SessionConfigOption[]; modes?: acp.SessionModeState }
export interface ChatState {
  status: 'disconnected' | 'connecting' | 'ready' | 'busy';
  harness?: HarnessId;
  connectionAttempted?: boolean;
  readOnly?: boolean;
  mobileControlled?: boolean;
  sessionId?: string; sessionNumber?: number; agent?: string; error?: string; entries: Entry[]; attachments: Attachment[];
  modes?: acp.SessionModeState;
  configs?: acp.SessionConfigOption[]; commands: acp.AvailableCommand[];
  plan: acp.PlanEntry[]; usage?: { used: number; size: number }; history: Omit<Snapshot, 'entries'>[];
  permissions: { id: string; request: acp.RequestPermissionRequest }[];
  showThoughts: boolean; preview: boolean;
  contextComplete?: boolean; contextPending?: boolean;
  nativeForks?: Record<string,NativeBranchTarget>;
  statistics?: Statistics; contextOperation?: {kind:'fork'} | {kind:'summary';done:number;total:number};
}
export type UiMessage =
  | { type: 'ready' | 'connect' | 'new' | 'cancel' | 'attach' | 'clearHistory' | 'login' | 'logs' | 'preview' | 'export' | 'refreshStatistics' | 'cancelContext' | 'copyConversation' | 'releaseSession' | 'refreshHistory' | 'takeDesktopControl' }
  | {type:'attachImages';harness?:HarnessId;sessionId?:string;images:import('./images').PastedImage[]}
  | {type:'attachmentError';harness?:HarnessId;sessionId?:string;error:string}
  | { type: 'switchHarness'; harness: HarnessId }
  | { type: 'setPrice'; model: string; price?: Price }
  | { type: 'send'; text: string }
  | { type: 'dismissError'; error: string }
  | { type: 'permission'; id: string; optionId?: string }
  | { type: 'mode'; value: string }
  | { type: 'config'; id: string; value: string }
  | { type: 'resume' | 'removeAttachment' | 'deleteHistory'; id: string }
  | { type: 'branchMessage'; id: string; sessionId: string }
  | { type: 'deleteMessage'; id: string; sessionId: string }
  | { type: 'diff'; id: string; index: number }
  | { type: 'open'; url: string; line?: number };
