/** Direct domain-to-webview contract; no ACP facade or compatibility wire patches. */
import {
  array,
  boolean,
  literal,
  nullable,
  object,
  optional,
  string,
  tagged,
  uint,
  variants,
  type Infer,
} from './workbench-schema';
import {
  clientCommand,
  imageRef,
  operationId,
  sessionId,
  sessionSnapshot,
  transcriptEntry,
  type DomainEvent,
  type ImageAsset,
  type OperationId,
  type SessionSnapshot,
} from './workbench-protocol';
import type { WorkbenchSessionView } from './workbench-session';

// Only user-originated commands; no internal event/ACP request or caller-selected operation ID.
export const uiCommand = tagged('type', {
  ready: object({ type: literal('ready') }),
  refresh: object({ type: literal('refresh') }),
  create: object({ type: literal('create'), command: clientCommand }),
  select: object({ type: literal('select'), session: sessionId }),
  execute: object({ type: literal('execute'), session: sessionId, command: clientCommand }),
  cancel_fork: object({ type: literal('cancel_fork'), operation: operationId }),
  read_image: object({ type: literal('read_image'), session: sessionId, image: imageRef }),
});
export type UiCommand = Infer<typeof uiCommand>;
export interface UiOperation {
  operation: OperationId;
  method: string;
  session?: string;
  status: 'pending' | 'completed' | 'failed';
  code?: string;
  error?: string;
}
export interface WorkbenchUiState {
  sessions: SessionSnapshot[];
  selected?: string;
  view?: WorkbenchSessionView;
  operations: UiOperation[];
  error?: string;
  workspace?: string;
  trusted: boolean;
}
export type WorkbenchUiMessage =
  | { type: 'state'; sequence: number; state: WorkbenchUiState }
  | { type: 'prompt_accepted'; session: string; text: string }
  | { type: 'image'; session: string; asset: ImageAsset }
  | { type: 'image_error'; session: string; image: string; error: string };
export function listed(events: DomainEvent[]) {
  for (const event of events) if ('SessionsListed' in event) return event.SessionsListed;
  throw new Error('Session list response missing');
}
// Shared output validation keeps the browser from trusting partial/old extension state.
const row = transcriptEntry;
export const uiState = object({
  sessions: array(sessionSnapshot),
  selected: optional(string),
  view: optional(
    object({
      status: variants({
        syncing: null,
        ready: null,
        stale: null,
        removed: null,
        disconnected: null,
      }),
      snapshot: optional(sessionSnapshot),
      provisional: array(row),
      error: optional(string),
    }),
  ),
  operations: array(
    object({
      operation: operationId,
      method: string,
      session: optional(string),
      status: variants({ pending: null, completed: null, failed: null }),
      code: optional(string),
      error: optional(string),
    }),
  ),
  error: optional(string),
  workspace: optional(string),
  trusted: boolean,
});
export const uiStateMessage = object({ type: literal('state'), sequence: uint, state: uiState });
