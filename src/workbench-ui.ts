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
  sessionSummary,
  sessionView,
  entryHeader,
  toolHeader,
  toolCursor,
  turnId,
  historyCursor,
  listCursor,
  contentRef,
  type ContentRef,
  type ContentSlice,
  type ImageAsset,
  type OperationId,
  type SessionSummary,
  type ListCursor,
} from './workbench-protocol';
import type { WorkbenchSessionView } from './workbench-session';

// Only user-originated commands; no internal event/ACP request or caller-selected operation ID.
export const uiCommand = tagged('type', {
  ready: object({ type: literal('ready') }),
  refresh: object({ type: literal('refresh'), cursor: optional(listCursor) }),
  create: object({ type: literal('create'), command: clientCommand }),
  select: object({ type: literal('select'), session: sessionId }),
  execute: object({ type: literal('execute'), session: sessionId, command: clientCommand }),
  cancel_fork: object({ type: literal('cancel_fork'), operation: operationId }),
  read_tools: object({
    type: literal('read_tools'),
    session: sessionId,
    turn: turnId,
    cursor: optional(toolCursor),
  }),
  read_content: object({
    type: literal('read_content'),
    session: sessionId,
    ref: contentRef,
    offset: uint,
    request_id: optional(uint),
  }),
  earlier: object({ type: literal('earlier'), session: sessionId }),
  latest: object({ type: literal('latest'), session: sessionId }),
  read_image: object({
    type: literal('read_image'),
    session: sessionId,
    image: imageRef,
    request_id: optional(uint),
  }),
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
  sessions: SessionSummary[];
  sessionsCursor?: ListCursor;
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
  | { type: 'image'; session: string; request_id?: number; asset: ImageAsset }
  | {
      type: 'content';
      session: string;
      request_id?: number;
      ref: ContentRef;
      offset: number;
      slice: ContentSlice;
    }
  | { type: 'image_error'; session: string; request_id?: number; image: string; error: string }
  | {
      type: 'content_error';
      session: string;
      request_id?: number;
      ref: ContentRef;
      offset: number;
      error: string;
    };
// Shared output validation keeps the browser from trusting partial/old extension state.
export const uiState = object({
  sessions: array(sessionSummary),
  sessionsCursor: optional(listCursor),
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
      view: optional(sessionView),
      entries: array(entryHeader),
      tools: array(toolHeader),
      toolCursor: optional(toolCursor),
      earlier: optional(historyCursor),
      historical: boolean,
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
