/** IPC v3 bounded DTOs; no ACP, full transcript snapshots or v2 decoder. */
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
export const turnId = id('turn');
const interactionId = id('interaction');
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
const config = object({
  model: nullable(modelId),
  mode: nullable(modeId),
  options: optional(
    checked(
      record(string),
      (options) =>
        Object.keys(options).length <= 32 &&
        Object.entries(options).every(
          ([id, value]) =>
            id.length > 0 && byteLength(id) <= 200 && value.length > 0 && byteLength(value) <= 200,
        ),
    ),
  ),
});
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
const selectString = (maximum: number) =>
  checked(string, (s) => s.length > 0 && byteLength(s) <= maximum && !/\p{Cc}/u.test(s));
const selectSetting = checked(
  object({
    id: selectString(200),
    name: selectString(512),
    category: nullable(selectString(200)),
    current_value: selectString(200),
    choices: checked(
      array(object({ value: selectString(200), name: selectString(512) })),
      (choices) =>
        choices.length > 0 &&
        choices.length <= 500 &&
        new Set(choices.map((c) => c.value)).size === choices.length,
    ),
  }),
  (s) => s.choices.some((c) => c.value === s.current_value),
);
export const typedPrompt = checked(
  object({
    parts: array(
      tagged('type', {
        text: object({ type: literal('text'), text: string }),
        context: object({ type: literal('context'), id: string, name: string, text: string }),
        image: object({ type: literal('image'), asset: imageAsset }),
      }),
    ),
  }),
  (p) => {
    let chars = 0,
      context = 0,
      images = 0;
    const ids = new Set<string>();
    for (const part of p.parts) {
      if (part.type === 'image') {
        images++;
        continue;
      }
      chars += [...part.text].length;
      if (part.type === 'context') {
        if (
          !part.id ||
          byteLength(part.id) > 200 ||
          ids.has(part.id) ||
          !part.name ||
          byteLength(part.name) > 4096 ||
          /\p{Cc}/u.test(part.name) ||
          byteLength(part.text) > 65536
        )
          return false;
        ids.add(part.id);
        context += [...part.text].length;
      }
    }
    return (
      p.parts.length > 0 &&
      p.parts.length <= 10 &&
      images <= 1 &&
      ids.size <= 8 &&
      chars <= 100000 &&
      context <= 80000 &&
      (images > 0 || p.parts.some((part) => part.type !== 'image' && /\S/u.test(part.text)))
    );
  },
);
const catalogue = object({
  selects: optional(
    checked(
      array(selectSetting),
      (settings) =>
        settings.length <= 32 &&
        new Set(settings.map((s) => s.id)).size === settings.length &&
        jsonBytes(settings) <= 128 * 1024,
    ),
  ),
  image_input: optional(boolean),
  models: array(object({ id: modelId, name: string })),
  modes: array(object({ id: modeId, name: string })),
  commands: array(object({ name: string, description: string, input_hint: nullable(string) })),
  current_model: optional(modelId),
  current_mode: optional(modeId),
});
/** Fixed v3 contracts shared by production client and server. */
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
export const turnDiff = object({
  status: oneOf('complete', 'partial', 'unavailable'),
  files: array(
    object({
      path: string,
      status: oneOf('added', 'modified', 'deleted'),
      before_hash: nullable(string),
      after_hash: nullable(string),
      before: nullable(string),
      after: nullable(string),
      old_mode: nullable(uint),
      new_mode: nullable(uint),
      added: uint,
      removed: uint,
      patch: nullable(string),
      omitted: nullable(string),
    }),
  ),
  warnings: array(string),
  added: uint,
  removed: uint,
  next_offset: nullable(uint),
});
export const undoReport = object({
  files: array(object({ path: string, status: string, error: nullable(string) })),
});
export type UndoReport = Infer<typeof undoReport>;
export type TurnDiff = Infer<typeof turnDiff>;
const money = schema((v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : invalid(),
);
export const modelPrice = checked(
  object({ input: money, output: money, cache_read: money, cache_write: money }),
  (p) => Object.values(p).every((n) => n <= 1000000),
);
export const managementAction = tagged('action', {
  rename: object({
    action: literal('rename'),
    title: checked(
      string,
      (s) => s.trim().length > 0 && [...s].length <= 80 && !/[\u0000-\u001f\u007f]/.test(s),
    ),
  }),
  model: object({
    action: literal('model'),
    model: checked(string, (s) => s.length > 0 && s.length <= 300),
    hidden: boolean,
    price: nullable(modelPrice),
  }),
  visibility: object({
    action: literal('visibility'),
    models: checked(
      array(string),
      (a) => a.length > 0 && a.length <= 500 && a.every((s) => s.length > 0 && s.length <= 300),
    ),
    hidden: boolean,
    reset: boolean,
  }),
  naming: object({
    action: literal('naming'),
    policy: oneOf('off', 'follow', 'model'),
    model: nullable(checked(string, (s) => s.length > 0 && s.length <= 300)),
  }),
  refresh_models: object({ action: literal('refresh_models') }),
  context: object({
    action: literal('context'),
    model: string,
    context_window: nullable(checked(uint, (n) => n > 0 && n <= 100000000)),
  }),
});
export const managementQuery = object({
  group: optional(nullable(oneOf('model', 'day', 'week', 'month', 'session'))),
  from: optional(nullable(uint)),
  to: optional(nullable(uint)),
  session: optional(nullable(sessionId)),
  model: optional(nullable(string)),
  cursor: optional(nullable(string)),
});
const usageGroup = object({
  label: optional(nullable(string)),
  key: string,
  calls: uint,
  missing: uint,
  cache_missing: uint,
  unpriced: uint,
  input: uint,
  output: uint,
  cache_read: uint,
  cache_write: uint,
  estimated_usd: money,
});
export const managementData = object({
  models: array(
    object({
      harness,
      model: string,
      hidden: boolean,
      price: nullable(modelPrice),
      default_price: nullable(modelPrice),
      context_window: nullable(uint),
    }),
  ),
  naming_policy: string,
  title_model: nullable(string),
  groups: array(usageGroup),
  totals: nullable(usageGroup),
  next_cursor: nullable(string),
});
export type ManagementData = Infer<typeof managementData>;
export type ManagementQuery = Infer<typeof managementQuery>;
export type ManagementAction = Infer<typeof managementAction>;
export const sessionSummary = object({
  retention_days: optional(checked(uint, (n) => n === 0 || n === 1 || n === 4)),
  title: optional(nullable(string)),
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
      reported: optional(boolean),
      cache_read_tokens: optional(nullable(uint)),
      cache_write_tokens: optional(nullable(uint)),
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
export const historyClearReport = object({
  job: operationId,
  total: uint,
  remaining: uint,
  failed: uint,
  active: uint,
  pending_deliveries: uint,
  preview: boolean,
});
export type HistoryClearReport = Infer<typeof historyClearReport>;
export const commandReceipt = checked(
  variants({
    HistoryClear: object({ report: historyClearReport }),
    Created: object({ summary: sessionSummary }),
    Loaded: object({ view: sessionView }),
    Accepted: object({ session: sessionId, revision: uint }),
    Forked: object({ summary: sessionSummary }),
    UndoCompleted: object({ session: sessionId, report: undoReport }),
    Removed: object({ session: sessionId }),
    ForkCancelRequested: object({ source: sessionId, operation: operationId }),
  }),
  (v) => jsonBytes(v) <= MAX_QUERY_BYTES,
);
export type CommandReceipt = Infer<typeof commandReceipt>;
export const operationStatus = tagged('status', {
  unknown: object({ status: literal('unknown') }),
  uncertain: object({ status: literal('uncertain') }),
  expired: object({ status: literal('expired') }),
  completed: object({ status: literal('completed'), receipt: commandReceipt }),
  failed: object({ status: literal('failed'), message: string }),
});
export type OperationStatus = Infer<typeof operationStatus>;
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
export const sessionFilter = object({
  text: checked(
    string,
    (s) =>
      byteLength(s) <= 300 &&
      !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  ),
  harness: nullable(harness),
});
export type SessionFilter = Infer<typeof sessionFilter>;
export const listCursor = object({
  version: literal(3),
  max_created_seq: uint,
  before_seq: uint,
  filter: optional(sessionFilter),
});
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
    operation: object({ method: literal('operation'), operation: operationId }),
    search: object({
      method: literal('search'),
      filter: sessionFilter,
      cursor: optional(nullable(listCursor)),
      limit: listLimit,
    }),
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
    management: object({ method: literal('management'), query: managementQuery }),
    validate_undo: object({
      method: literal('validate_undo'),
      session: sessionId,
      turn: turnId,
      files: optional(
        nullable(
          checked(
            array(checked(string, (s) => byteLength(s) <= 1024)),
            (v) =>
              v.length > 0 && v.length <= 256 && v.reduce((n, s) => n + byteLength(s), 0) <= 65536,
          ),
        ),
      ),
    }),
    turn_diff: object({
      method: literal('turn_diff'),
      session: sessionId,
      turn: turnId,
      offset: optional(uint),
    }),
    turn_diff_content: object({
      method: literal('turn_diff_content'),
      session: sessionId,
      turn: turnId,
      file: uint,
      after: boolean,
      offset: uint,
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
      case 'turn_diff':
      case 'turn_diff_content':
        return true;
      default:
        return true;
    }
  },
);
export const queryRequest = object({ version: literal(3), id: uint, command: queryCommand });
export type ListPage = Infer<typeof listPage>;
export type HistoryPage = Infer<typeof historyPage>;
export type ToolPage = Infer<typeof toolPage>;
export type ContentSlice = Infer<typeof contentSlice>;
export type Attached = Infer<typeof attached>;
export type ListCursor = Infer<typeof listCursor>;
export type HistoryCursor = Infer<typeof historyCursor>;
export type ToolCursor = Infer<typeof toolCursor>;
export type QueryCommand = Infer<typeof queryCommand>;
const session = { session: sessionId };
const mutationCommand = tagged('method', {
  create: object({ method: literal('create'), harness, cwd: workspacePath }),
  load: object({ method: literal('load'), ...session }),
  prompt: object({
    method: literal('prompt'),
    ...session,
    prompt: typedPrompt,
  }),
  cancel: object({ method: literal('cancel'), ...session }),
  answer: object({ method: literal('answer'), ...session, answer }),
  fork: object({ method: literal('fork'), ...session, request: object({ entry: entryId }) }),
  cancel_fork: object({ method: literal('cancel_fork'), ...session, operation: operationId }),
  discover: object({ method: literal('discover'), ...session }),
  set_model: object({ method: literal('set_model'), ...session, model: modelId }),
  set_mode: object({ method: literal('set_mode'), ...session, mode: modeId }),
  set_option: object({
    method: literal('set_option'),
    ...session,
    id: checked(string, (s) => !!s && byteLength(s) <= 200),
    value: checked(string, (s) => !!s && byteLength(s) <= 200),
  }),
  manage: object({ method: literal('manage'), session: sessionId, action: managementAction }),
  prepare_history_clear: object({
    method: literal('prepare_history_clear'),
    filter: sessionFilter,
  }),
  clear_history_batch: object({ method: literal('clear_history_batch'), job: operationId }),
  undo_turn: object({
    method: literal('undo_turn'),
    session: sessionId,
    turn: turnId,
    files: optional(
      nullable(
        checked(
          array(checked(string, (s) => byteLength(s) <= 1024)),
          (v) =>
            v.length > 0 && v.length <= 256 && v.reduce((n, s) => n + byteLength(s), 0) <= 65536,
        ),
      ),
    ),
  }),
  remove: object({ method: literal('remove'), ...session }),
});
const detachCommand = object({ method: literal('detach'), ...session });
const queryMethods = new Set([
  'operation',
  'list',
  'inspect',
  'history',
  'tools',
  'content',
  'attach',
  'image',
  'management',
  'search',
  'validate_undo',
  'turn_diff',
  'turn_diff_content',
]);
export const clientCommand = schema(
  (value): QueryCommand | Infer<typeof mutationCommand> | Infer<typeof detachCommand> => {
    if (!value || typeof value !== 'object' || !('method' in value)) invalid();
    if (queryMethods.has(String(value.method))) return queryCommand.parse(value);
    if (value.method === 'detach') return detachCommand.parse(value);
    return mutationCommand.parse(value);
  },
);
export type ClientCommand = Infer<typeof clientCommand>;
export const queryResult = tagged('kind', {
  operation: object({ kind: literal('operation'), value: operationStatus }),
  list: object({ kind: literal('list'), value: listPage }),
  view: object({ kind: literal('view'), value: sessionView }),
  history: object({ kind: literal('history'), value: historyPage }),
  tools: object({ kind: literal('tools'), value: toolPage }),
  content: object({ kind: literal('content'), value: contentSlice }),
  turn_diff_content: object({
    kind: literal('turn_diff_content'),
    value: object({ bytes: string, total_bytes: uint, next_offset: nullable(uint) }),
  }),
  management: object({ kind: literal('management'), value: managementData }),
  validate_undo: object({ kind: literal('validate_undo'), value: undoReport }),
  turn_diff: object({ kind: literal('turn_diff'), value: turnDiff }),
  attached: object({ kind: literal('attached'), value: attached }),
});
export type QueryResult = Infer<typeof queryResult>;
export const ipcMessage = checked(
  tagged('type', {
    reply: object({ type: literal('reply'), id: uint, receipt: commandReceipt }),
    query: object({ type: literal('query'), id: uint, result: queryResult }),
    detached: object({ type: literal('detached'), id: uint, session: sessionId }),
    image: object({ type: literal('image'), id: uint, asset: imageAsset }),
    error: object({ type: literal('error'), id: uint, code: string, message: string }),
    batch: object({ type: literal('batch'), batch: commitBatch }),
    resync_required: object({ type: literal('resync_required') }),
  }),
  (value) => jsonBytes(value) <= (value.type === 'image' ? MAX_FRAME_BYTES : MAX_QUERY_BYTES),
);
export type IpcMessage = Infer<typeof ipcMessage>;
export type CommandResult<C extends ClientCommand> = C extends { method: 'validate_undo' }
  ? UndoReport
  : C extends { method: 'management' }
    ? ManagementData
    : C extends { method: 'operation' }
      ? OperationStatus
      : C extends { method: 'image' }
        ? ImageAsset
        : C extends { method: 'list' | 'search' }
          ? ListPage
          : C extends { method: 'inspect' }
            ? SessionView
            : C extends { method: 'history' }
              ? HistoryPage
              : C extends { method: 'tools' }
                ? ToolPage
                : C extends { method: 'content' }
                  ? ContentSlice
                  : C extends { method: 'undo_turn' }
                    ? CommandReceipt
                    : C extends { method: 'turn_diff' }
                      ? TurnDiff
                      : C extends { method: 'turn_diff_content' }
                        ? { bytes: string; total_bytes: number; next_offset?: number | null }
                        : C extends { method: 'attach' }
                          ? Attached
                          : C extends { method: 'detach' }
                            ? SessionId
                            : CommandReceipt;
export function commandPool(command: ClientCommand): 0 | 1 | 2 {
  if (queryMethods.has(command.method) || command.method === 'detach') return 2;
  if (['cancel', 'cancel_fork', 'answer', 'remove', 'undo_turn'].includes(command.method)) return 1;
  return 0;
}
export function durableCommand(command: ClientCommand) {
  return commandPool(command) !== 2;
}
