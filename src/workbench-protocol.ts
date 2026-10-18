/** IPC v2 public DTOs. Decoders mirror Rust domain + transport/vscode; no ACP/legacy types. */
import {
  array,
  boolean,
  checked,
  integer,
  invalid,
  literal,
  nullable,
  object,
  oneOf,
  optional,
  record,
  schema,
  string,
  tagged,
  uint,
  variants,
  type Infer,
} from './workbench-schema';

declare const idBrand: unique symbol;
type Id<K extends string> = string & { readonly [idBrand]: K };
const byteLength = (s: string) => new TextEncoder().encode(s).length;
const id = <K extends string>(kind: K, opaque = false) =>
  schema((value): Id<K> => {
    const s = string.parse(value);
    if (
      !s ||
      s === '.' ||
      s === '..' ||
      byteLength(s) > 200 ||
      (opaque
        ? /^\p{White_Space}|\p{White_Space}$/u.test(s) || /\p{Cc}/u.test(s)
        : !/^[a-zA-Z0-9_.-]+$/.test(s))
    )
      invalid();
    return s as Id<K>;
  });
export const sessionId = id('session');
export type SessionId = Infer<typeof sessionId>;
export const entryId = id('entry');
export type EntryId = Infer<typeof entryId>;
export const operationId = id('operation');
export type OperationId = Infer<typeof operationId>;
export const imageId = id('image');
const turnId = id('turn'),
  interactionId = id('interaction');
const providerSessionId = id('provider-session', true),
  providerEntryId = id('provider-entry', true);
const messageId = id('provider-message', true),
  toolId = id('tool', true),
  terminalId = id('terminal', true);
export const modelId = id('model', true),
  modeId = id('mode', true);
export const workspacePath = checked(
  string,
  (s) =>
    s.startsWith('/') && byteLength(s) <= 4096 && !s.includes('\0') && !s.split('/').includes('..'),
);
const digest = checked(string, (s) => /^[0-9a-f]{64}$/.test(s));
const harness = oneOf('Pi', 'Codex', 'Claude');
const status = variants({
  Idle: null,
  Running: null,
  Waiting: null,
  Cancelling: null,
  Failed: string,
});
const config = object({ model: nullable(modelId), mode: nullable(modeId) });
const choice = object({ id: string, label: string });
const fieldKind = variants({
  Text: object({ max_length: uint }),
  Choice: object({ options: array(choice), multiple: boolean }),
  Boolean: null,
  Integer: object({ min: nullable(integer), max: nullable(integer) }),
});
const fieldValue = variants({
  Text: string,
  Selected: array(string),
  Boolean: boolean,
  Integer: integer,
});
const interaction = object({
  id: interactionId,
  kind: oneOf('Permission', 'Elicitation'),
  title: string,
  detail: string,
  fields: array(object({ name: string, label: string, required: boolean, kind: fieldKind })),
  options: array(choice),
  expires_at: nullable(uint),
});
const answer = object({
  interaction: interactionId,
  response: variants({
    Text: string,
    Permission: object({ option: string }),
    Form: object({ fields: record(fieldValue) }),
    Decline: null,
    Cancel: null,
  }),
});
export type Interaction = Infer<typeof interaction>;
export type InteractionAnswer = Infer<typeof answer>;
const resolution = variants({
  Answered: answer,
  Cancelled: object({ interaction: interactionId }),
});
const toolStatus = oneOf('Pending', 'InProgress', 'Completed', 'Failed');
const toolKind = oneOf(
  'Read',
  'Edit',
  'Delete',
  'Move',
  'Search',
  'Execute',
  'Think',
  'Fetch',
  'SwitchMode',
  'Other',
);
const toolContent = variants({
  Text: object({ text: string }),
  Diff: object({ path: string, old_text: nullable(string), new_text: string }),
  ResourceText: object({ uri: string, text: string, mime_type: nullable(string) }),
  ResourceLink: object({ uri: string, name: string, mime_type: nullable(string) }),
  TerminalReference: object({ id: terminalId }),
  Unsupported: object({ kind: oneOf('Image', 'Audio', 'ResourceBlob', 'Unknown') }),
});
const tool = object({
  id: toolId,
  turn: turnId,
  title: string,
  status: toolStatus,
  details: object({
    kind: nullable(toolKind),
    name: nullable(string),
    content: array(toolContent),
    locations: array(
      object({ path: string, line: nullable(checked(uint, (n) => n <= 0xffffffff)) }),
    ),
  }),
});
export type ToolCall = Infer<typeof tool>;
const plan = object({ items: array(object({ description: string, status: toolStatus })) });
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const imageRef = object({
  id: imageId,
  mime: oneOf('image/png', 'image/jpeg', 'image/gif', 'image/webp'),
  bytes: checked(uint, (n) => n > 0 && n <= MAX_IMAGE_BYTES),
  sha256: digest,
});
export type ImageRef = Infer<typeof imageRef>;
const imageAsset = object({
  format_version: literal(1),
  image: imageRef,
  data: checked(string, (s) => s.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
});
export type ImageAsset = Infer<typeof imageAsset>;
const forkTarget = object({ entry: providerEntryId, prefix: digest });
export const transcriptEntry = object({
  id: entryId,
  turn: turnId,
  role: oneOf('User', 'Agent', 'Thought', 'Tool'),
  text: string,
  message: optional(messageId),
  image: optional(imageRef),
});
const transcript = object({
  origin: optional(object({ session: sessionId, entry: entryId, target: forkTarget })),
  entries: array(transcriptEntry),
  tools: record(record(tool, toolId), turnId),
});
const catalogue = object({
  models: array(object({ id: modelId, name: string })),
  modes: array(object({ id: modeId, name: string })),
  commands: array(object({ name: string, description: string, input_hint: nullable(string) })),
  current_model: optional(modelId),
  current_mode: optional(modeId),
});
export const sessionSnapshot = object({
  id: sessionId,
  provider_session: nullable(providerSessionId),
  harness,
  cwd: workspacePath,
  status,
  transcript,
  plan,
  active_turn: nullable(turnId),
  pending_interactions: record(interaction, interactionId),
  usage: object({
    input_tokens: uint,
    output_tokens: uint,
    cost_micros: uint,
    context_used: nullable(uint),
    context_size: nullable(uint),
  }),
  config,
  configuration_intent: optional(object({ requested: config, restore: config })),
  catalogue,
  revision: uint,
});
export type SessionSnapshot = Infer<typeof sessionSnapshot>;
const textDelta = object({
  session: sessionId,
  turn: turnId,
  entry: entryId,
  message: nullable(messageId),
  text: string,
});
const turn = object({ session: sessionId, turn: turnId });
/** ForkPrepared is internal-only and intentionally not accepted from the public socket. */
export const domainEvent = variants({
  SessionCreated: sessionSnapshot,
  SessionLoaded: sessionSnapshot,
  SessionsListed: array(sessionSnapshot),
  ForkCancelled: object({ session: sessionId, operation: operationId }),
  CatalogueChanged: object({ session: sessionId, catalogue }),
  ProviderSessionAttached: object({ session: sessionId, provider_session: providerSessionId }),
  UserPromptAdded: object({ session: sessionId, turn: turnId, entry: entryId, prompt: string }),
  AgentText: textDelta,
  AgentThought: textDelta,
  AgentImage: object({
    session: sessionId,
    turn: turnId,
    entry: entryId,
    message: nullable(messageId),
    image: imageRef,
  }),
  ToolCallChanged: object({ session: sessionId, tool }),
  PlanChanged: object({ session: sessionId, plan }),
  InteractionRequested: object({ session: sessionId, interaction }),
  InteractionResolved: object({ session: sessionId, resolution }),
  UsageChanged: object({ session: sessionId, input_tokens: uint, output_tokens: uint }),
  ContextUsageChanged: object({ session: sessionId, used: uint, size: uint }),
  TurnStarted: turn,
  TurnFinished: turn,
  TurnCancelled: turn,
  SessionError: object({ session: sessionId, error: string }),
  SessionRemoved: sessionId,
});
export type DomainEvent = Infer<typeof domainEvent>;
const session = { session: sessionId };
export const clientCommand = tagged('method', {
  create: object({ method: literal('create'), harness, cwd: workspacePath }),
  load: object({ method: literal('load'), ...session }),
  list: object({ method: literal('list') }),
  inspect: object({ method: literal('inspect'), ...session }),
  image: object({ method: literal('image'), image: imageRef }),
  prompt: object({
    method: literal('prompt'),
    ...session,
    prompt: checked(string, (s) => /\S/u.test(s) && [...s].length <= 100_000),
  }),
  cancel: object({ method: literal('cancel'), ...session }),
  answer: object({ method: literal('answer'), ...session, answer }),
  fork: object({ method: literal('fork'), ...session, request: object({ entry: entryId }) }),
  cancel_fork: object({ method: literal('cancel_fork'), ...session, operation: operationId }),
  set_model: object({ method: literal('set_model'), ...session, model: modelId }),
  set_mode: object({ method: literal('set_mode'), ...session, mode: modeId }),
  remove: object({ method: literal('remove'), ...session }),
  subscribe: object({ method: literal('subscribe'), ...session }),
  unsubscribe: object({ method: literal('unsubscribe'), ...session }),
});
export type ClientCommand = Infer<typeof clientCommand>;
export const ipcMessage = tagged('type', {
  reply: object({ type: literal('reply'), id: uint, events: array(domainEvent) }),
  image: object({ type: literal('image'), id: uint, asset: imageAsset }),
  error: object({ type: literal('error'), id: uint, code: string, message: string }),
  event: object({ type: literal('event'), event: domainEvent }),
  resync_required: object({ type: literal('resync_required') }),
});
export type IpcMessage = Infer<typeof ipcMessage>;
export type CommandResult<C extends ClientCommand> = C extends { method: 'image' }
  ? ImageAsset
  : DomainEvent[];
export function commandPool(command: ClientCommand): 0 | 1 | 2 {
  switch (command.method) {
    case 'list':
    case 'inspect':
    case 'image':
      return 2;
    case 'cancel':
    case 'cancel_fork':
    case 'answer':
    case 'remove':
      return 1;
    default:
      return 0;
  }
}
export function durableCommand(command: ClientCommand) {
  return !['list', 'inspect', 'image', 'subscribe', 'unsubscribe'].includes(command.method);
}

/** Fixed v3 contracts; production client switches in T08, server in T07. */
export const PROTOCOL_VERSION_V3 = 3;
export const STORAGE_VERSION_V3 = 3;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_QUERY_BYTES = 1024 * 1024;
export const MAX_VIEW_BYTES = 512 * 1024;
export const INLINE_TEXT_BYTES = 16 * 1024;
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const CONTENT_SLICE_BYTES = 64 * 1024;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_PENDING_INTERACTIONS = 32;
export const jsonBytes = (value: unknown) => byteLength(JSON.stringify(value));
export function checkJsonBudget<T>(value: T, budget: number): T {
  if (jsonBytes(value) > budget) invalid();
  return value;
}
export function queryLimit(value: number | undefined, fallback: number, maximum: number) {
  const n = uint.parse(value ?? fallback);
  return n > 0 && n <= maximum ? n : invalid();
}
export const contentKind = oneOf('Text', 'ToolText', 'ToolDiff', 'ToolResource');
export const contentRef = object({
  id: id('content'),
  sha256: digest,
  bytes: checked(uint, (n) => n <= MAX_CONTENT_BYTES),
  kind: contentKind,
});
export type ContentRef = Infer<typeof contentRef>;
export const textBody = variants({
  Inline: object({ text: checked(string, (s) => byteLength(s) <= INLINE_TEXT_BYTES) }),
  Archived: object({ content: checked(contentRef, (r) => r.kind === 'Text') }),
});
export type TextBody = Infer<typeof textBody>;
export const sessionSummary = object({
  id: sessionId,
  harness,
  cwd: workspacePath,
  status,
  revision: uint,
  created_seq: uint,
});
export type SessionSummary = Infer<typeof sessionSummary>;
export const sessionView = checked(
  object({
    id: sessionId,
    provider_session: nullable(providerSessionId),
    harness,
    cwd: workspacePath,
    status,
    config,
    configuration_intent: nullable(object({ requested: config, restore: config })),
    catalogue,
    plan,
    usage: object({
      input_tokens: uint,
      output_tokens: uint,
      cost_micros: uint,
      context_used: nullable(uint),
      context_size: nullable(uint),
    }),
    active_turn: nullable(turnId),
    pending_interactions: checked(
      record(interaction, interactionId),
      (items) =>
        Object.keys(items).length <= MAX_PENDING_INTERACTIONS &&
        Object.entries(items).every(([key, item]) => key === item.id),
    ),
    origin: nullable(object({ session: sessionId, entry: entryId, target: forkTarget })),
    revision: uint,
    last_entry_seq: uint,
  }),
  (v) => jsonBytes(v) <= MAX_VIEW_BYTES,
);
export type SessionView = Infer<typeof sessionView>;
export const entryHeader = object({
  seq: uint,
  id: entryId,
  turn: turnId,
  role: oneOf('User', 'Agent', 'Thought', 'Tool'),
  message: nullable(messageId),
  text: textBody,
  image: nullable(imageRef),
});
export type EntryHeader = Infer<typeof entryHeader>;
const contentOfKind = (kind: ContentRef['kind']) => checked(contentRef, (r) => r.kind === kind);
export const toolBody = variants({
  Text: object({ content: contentOfKind('ToolText') }),
  Diff: object({
    path: string,
    old_text: nullable(contentOfKind('ToolDiff')),
    new_text: contentOfKind('ToolDiff'),
  }),
  ResourceText: object({
    uri: string,
    content: contentOfKind('ToolResource'),
    mime_type: nullable(string),
  }),
  ResourceLink: object({ uri: string, name: string, mime_type: nullable(string) }),
  TerminalReference: object({ id: terminalId }),
  Unsupported: object({ kind: oneOf('Image', 'Audio', 'ResourceBlob', 'Unknown') }),
});
export const toolHeader = checked(
  object({
    id: toolId,
    turn: turnId,
    status: toolStatus,
    kind: nullable(toolKind),
    title: string,
    name: nullable(string),
    locations: array(
      object({ path: string, line: nullable(checked(uint, (n) => n <= 0xffffffff)) }),
    ),
    content: array(toolBody),
  }),
  (v) => jsonBytes(v) <= MAX_QUERY_BYTES,
);
export type ToolHeader = Infer<typeof toolHeader>;
export const commandReceipt = checked(
  variants({
    Created: object({ summary: sessionSummary }),
    Loaded: object({ view: sessionView }),
    Accepted: object({ session: sessionId, revision: uint }),
    Forked: object({ summary: sessionSummary }),
    Removed: object({ session: sessionId }),
    ForkCancelRequested: object({ source: sessionId, operation: operationId }),
  }),
  (v) => jsonBytes(v) <= MAX_QUERY_BYTES,
);
export type CommandReceipt = Infer<typeof commandReceipt>;
export const commitBatch = checked(
  object({
    session: sessionId,
    revision: uint,
    view: nullable(sessionView),
    entries: array(entryHeader),
    tools: array(toolHeader),
    removed: boolean,
  }),
  (v) =>
    jsonBytes(v) <= MAX_QUERY_BYTES &&
    (!v.view || (v.view.id === v.session && v.view.revision === v.revision)) &&
    (!v.removed || (!v.view && v.entries.length === 0 && v.tools.length === 0)),
);
export type CommitBatch = Infer<typeof commitBatch>;
export const queryError = oneOf('InvalidInput', 'UnsupportedVersion', 'TooLarge');
export const listCursor = object({ version: literal(3), max_created_seq: uint, before_seq: uint });
export const historyCursor = object({
  version: literal(3),
  session: sessionId,
  max_entry_seq: uint,
  before_seq: uint,
});
export const toolCursor = object({
  version: literal(3),
  session: sessionId,
  turn: turnId,
  after_tool: toolId,
});
export const listPage = checked(
  object({ sessions: array(sessionSummary), next_cursor: nullable(listCursor) }),
  (v) => v.sessions.length <= MAX_LIST_LIMIT && jsonBytes(v) <= MAX_QUERY_BYTES,
);
export const historyPage = checked(
  object({ entries: array(entryHeader), next_cursor: nullable(historyCursor) }),
  (v) => v.entries.length <= MAX_HISTORY_LIMIT && jsonBytes(v) <= MAX_QUERY_BYTES,
);
export const toolPage = checked(
  object({ tools: array(toolHeader), next_cursor: nullable(toolCursor) }),
  (v) => v.tools.length <= MAX_HISTORY_LIMIT && jsonBytes(v) <= MAX_QUERY_BYTES,
);
export const contentSlice = checked(
  object({
    text: checked(string, (s) => byteLength(s) <= CONTENT_SLICE_BYTES),
    next_offset: nullable(uint),
    sha256: digest,
    total_bytes: checked(uint, (n) => n <= MAX_CONTENT_BYTES),
  }),
  (v) => v.next_offset === null || v.next_offset <= v.total_bytes,
);
export const attached = checked(
  object({ view: sessionView, recent_page: historyPage }),
  (v) => jsonBytes(v) <= MAX_QUERY_BYTES,
);
const listLimit = optional(nullable(checked(uint, (n) => n > 0 && n <= MAX_LIST_LIMIT)));
const historyLimit = optional(nullable(checked(uint, (n) => n > 0 && n <= MAX_HISTORY_LIMIT)));
export const queryCommand = checked(
  tagged('method', {
    list: object({
      method: literal('list'),
      cursor: optional(nullable(listCursor)),
      limit: listLimit,
    }),
    inspect: object({ method: literal('inspect'), session: sessionId }),
    history: object({
      method: literal('history'),
      session: sessionId,
      cursor: optional(nullable(historyCursor)),
      limit: historyLimit,
    }),
    tools: object({
      method: literal('tools'),
      session: sessionId,
      turn: turnId,
      cursor: optional(nullable(toolCursor)),
      limit: historyLimit,
    }),
    content: object({
      method: literal('content'),
      ref: contentRef,
      offset: uint,
      length: optional(nullable(checked(uint, (n) => n > 0 && n <= CONTENT_SLICE_BYTES))),
    }),
    attach: object({ method: literal('attach'), session: sessionId }),
    image: object({ method: literal('image'), image: imageRef }),
  }),
  (v) => {
    switch (v.method) {
      case 'list':
        return (
          !v.cursor || (v.cursor.before_seq > 0 && v.cursor.before_seq <= v.cursor.max_created_seq)
        );
      case 'history':
        return (
          !v.cursor ||
          (v.cursor.session === v.session &&
            v.cursor.before_seq > 0 &&
            v.cursor.before_seq <= v.cursor.max_entry_seq)
        );
      case 'tools':
        return !v.cursor || (v.cursor.session === v.session && v.cursor.turn === v.turn);
      case 'content':
        return v.offset <= v.ref.bytes;
      default:
        return true;
    }
  },
);
export const queryRequest = object({ version: literal(3), id: uint, command: queryCommand });
