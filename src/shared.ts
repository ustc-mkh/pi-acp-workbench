import type * as acp from '@agentclientprotocol/sdk';
export type Entry = { id: string; role: 'user' | 'assistant' | 'thought' | 'notice'; text: string; messageId?: string | null; contextBlocks?: acp.ContentBlock[] } | { id: string; role: 'tool'; tool: acp.ToolCall };
export interface Attachment { id: string; name: string; uri: string; text: string }
export interface Snapshot { id: string; cwd: string; title: string; updated: number; entries: Entry[]; contextComplete?: boolean; contextPending?: boolean; configs?: acp.SessionConfigOption[]; modes?: acp.SessionModeState }
export interface ChatState {
  status: 'disconnected' | 'connecting' | 'ready' | 'busy';
  connectionAttempted?: boolean;
  sessionId?: string; agent?: string; error?: string; entries: Entry[]; attachments: Attachment[];
  modes?: acp.SessionModeState;
  configs?: acp.SessionConfigOption[]; commands: acp.AvailableCommand[];
  plan: acp.PlanEntry[]; usage?: { used: number; size: number }; history: Omit<Snapshot, 'entries'>[];
  permissions: { id: string; request: acp.RequestPermissionRequest }[];
  showThoughts: boolean; preview: boolean;
  contextComplete?: boolean; contextPending?: boolean;
}
export type UiMessage =
  | { type: 'ready' | 'connect' | 'new' | 'cancel' | 'attach' | 'clearHistory' | 'login' | 'logs' | 'preview' | 'export' }
  | { type: 'send'; text: string }
  | { type: 'dismissError'; error: string }
  | { type: 'permission'; id: string; optionId?: string }
  | { type: 'mode'; value: string }
  | { type: 'config'; id: string; value: string }
  | { type: 'resume' | 'removeAttachment' | 'deleteHistory'; id: string }
  | { type: 'branchMessage' | 'deleteMessage'; id: string; sessionId: string }
  | { type: 'diff'; id: string; index: number }
  | { type: 'open'; url: string; line?: number };
