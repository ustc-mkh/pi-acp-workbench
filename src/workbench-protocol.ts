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
