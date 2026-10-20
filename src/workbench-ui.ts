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
  managementQuery,
  managementData,
  imageRef,
  operationId,
  sessionId,
  sessionSummary,
  sessionView,
  entryHeader,
  entryId,
  toolHeader,
  toolCursor,
  undoReport,
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
  open_link: object({ type: literal('open_link'), url: string }),
  login: object({ type: literal('login') }),
  copy_message: object({ type: literal('copy_message'), session: sessionId, entry: entryId }),
  configure_telegram: object({ type: literal('configure_telegram') }),
  read_management: object({
    type: literal('read_management'),
    query: managementQuery,
    request_id: uint,
  }),
  attach_files: object({ type: literal('attach_files'), session: sessionId }),
  export: object({ type: literal('export'), session: sessionId }),
  recover_operations: object({ type: literal('recover_operations') }),
  refresh_names: object({ type: literal('refresh_names') }),
  ready: object({ type: literal('ready') }),
  refresh: object({ type: literal('refresh'), cursor: optional(listCursor) }),
  create: object({ type: literal('create'), command: clientCommand }),
  select: object({ type: literal('select'), session: sessionId }),
  execute: object({
    type: literal('execute'),
    session: sessionId,
    command: clientCommand,
    generation: optional(uint),
  }),
  cancel_fork: object({ type: literal('cancel_fork'), operation: operationId }),
  open_turn_diff: object({
    type: literal('open_turn_diff'),
    session: sessionId,
    turn: turnId,
    file: optional(uint),
  }),
  read_turn_diff: object({
    type: literal('read_turn_diff'),
    session: sessionId,
    turn: turnId,
    offset: optional(uint),
  }),
  read_turn_diff_content: object({
    type: literal('read_turn_diff_content'),
    session: sessionId,
    turn: turnId,
    file: uint,
    after: boolean,
    offset: uint,
  }),
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
  status: 'pending' | 'completed' | 'failed' | 'uncertain';
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
  | { type: 'management'; request_id: number; data: import('./workbench-protocol').ManagementData }
  | { type: 'management_error'; request_id: number; error: string }
  | { type: 'state'; sequence: number; state: WorkbenchUiState }
  | { type: 'prompt_submitted'; session: string; operation: OperationId; generation?: number }
  | {
      type: 'prompt_accepted';
      session: string;
      operation: OperationId;
      prompt: import('./workbench-input').TypedPrompt;
      generation?: number;
      pi_after_seq?: number;
    }
  | { type: 'attachments'; session: string; files: import('./workbench-input').TextAttachment[] }
  | {
      type: 'turn_diff';
      session: string;
      turn: string;
      offset?: number;
      diff: import('./workbench-protocol').TurnDiff;
    }
  | { type: 'turn_diff_error'; session: string; turn: string; error: string }
  | {
      type: 'turn_diff_content';
      session: string;
      turn: string;
      file: number;
      after: boolean;
      offset: number;
      bytes: string;
      total_bytes: number;
      next_offset?: number | null;
    }
  | {
      type: 'undo_result';
      session: string;
      turn: string;
      report: import('./workbench-protocol').UndoReport;
    }
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
export const uiOperation = object({
  operation: operationId,
  method: string,
  session: optional(string),
  status: variants({ pending: null, completed: null, failed: null, uncertain: null }),
  code: optional(string),
  error: optional(string),
});
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
  operations: array(uiOperation),
  error: optional(string),
  workspace: optional(string),
  trusted: boolean,
});
export const uiStateMessage = object({ type: literal('state'), sequence: uint, state: uiState });
