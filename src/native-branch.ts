import { createHash } from 'node:crypto';
export const NATIVE_FORK_MARKER = 'pi-acp-workbench/native-fork';
/** Fields consumed from Pi RPC/native history; preserve unknown fields when hashing. */
export interface NativeContent {
  type: string;
  id?: string;
  text?: string;
  [key: string]: unknown;
}
export interface NativeMessage {
  role?: string;
  content?: string | NativeContent[];
  toolCallId?: string;
  stopReason?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  [key: string]: unknown;
}
export interface NativeEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: NativeMessage;
  firstKeptEntryId?: string;
  targetId?: string;
  replacement?: string | NativeContent[] | null;
  provider?: string;
  modelId?: string;
  customType?: string;
  timestamp?: number;
  data?: { sourceSessionId?: string; [key: string]: unknown };
  [key: string]: unknown;
}
export interface NativeForkPoint {
  entryId: string;
  hash: string;
  role: 'user' | 'assistant';
  key: string;
  timestamp?: number;
  safe: boolean;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function nativePath(entries: NativeEntry[], leafId: string | null): NativeEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (byId.size !== entries.length) throw new Error('原生历史包含重复节点，无法安全分支。');
  const seen = new Set<string>(),
    path: NativeEntry[] = [];
  while (leafId) {
    const e = byId.get(leafId);
    if (!e || seen.has(leafId)) throw new Error('原生历史链不完整，无法安全分支。');
    seen.add(leafId);
    path.push(e);
    leafId = e.parentId;
  }
  return path.reverse();
}
/** Labels are UI metadata and Pi re-creates them when forking. Context payloads stay byte-equivalent. */
function canonicalEntries(path: NativeEntry[]) {
  const next = new Map<string, string>();
  let labels: string[] = [];
  for (const e of path) {
    if (e.type === 'label') labels.push(e.id);
    else {
      for (const id of labels) next.set(id, e.id);
      labels = [];
    }
  }
  return path.map((e) => {
    if (e.type === 'label') return undefined;
    const { parentId, ...data } = e;
    if (
      data.type === 'compaction' &&
      data.firstKeptEntryId !== undefined &&
      next.has(data.firstKeptEntryId)
    )
      data.firstKeptEntryId = next.get(data.firstKeptEntryId);
    return data;
  });
}
export function nativePrefixHash(path: NativeEntry[]) {
  return digest(JSON.stringify(canonicalEntries(path).filter(Boolean)));
}
const textOf = (content: NativeMessage['content']) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join('')
      : '';
export const nativeTextKey = (role: string, text: string) => `${role}:${digest(text)}`;
export function nativeForkPoints(path: NativeEntry[]): NativeForkPoint[] {
  const points: NativeForkPoint[] = [],
    messages = new Map<string, NativeMessage>(),
    calls = new Set<string | undefined>(),
    results = new Set<string | undefined>();
  const canonical = canonicalEntries(path),
    prefix = createHash('sha256').update('[');
  let comma = false,
    contextStart = 0;
  const positions = new Map(path.map((e, i) => [e.id, i]));
  const rebuild = () => {
    calls.clear();
    results.clear();
    for (const m of messages.values()) {
      if (m.role === 'assistant' && Array.isArray(m.content))
        for (const c of m.content) if (c.type === 'toolCall') calls.add(c.id);
      if (m.role === 'toolResult') results.add(m.toolCallId);
    }
  };
  for (let i = 0; i < path.length; i++) {
    const e = path[i],
      m = e.message;
    if (canonical[i]) {
      if (comma) prefix.update(',');
      prefix.update(JSON.stringify(canonical[i]));
      comma = true;
    }
    if (e.type === 'message' && m) {
      messages.set(e.id, m);
      if (m.role === 'assistant' && Array.isArray(m.content))
        for (const c of m.content) if (c.type === 'toolCall') calls.add(c.id);
      if (m.role === 'toolResult') results.add(m.toolCallId);
    }
    if (e.type === 'compaction') {
      const boundary =
        e.firstKeptEntryId !== undefined ? positions.get(e.firstKeptEntryId) : undefined;
      if (boundary === undefined || boundary > i)
        throw new Error('原生压缩边界无效，无法安全分支。');
      contextStart = boundary;
      for (const id of messages.keys()) if (positions.get(id)! < boundary) messages.delete(id);
      rebuild();
    }
    if (e.type === 'context_edit') {
      const position = e.targetId !== undefined ? positions.get(e.targetId) : undefined,
        old = position === undefined ? undefined : path[position].message;
      if (position !== undefined && position >= contextStart) {
        if (e.replacement === null) messages.delete(e.targetId!);
        else if (old) messages.set(e.targetId!, { ...old, content: e.replacement });
        rebuild();
      }
    }
    if (e.type !== 'message' || !m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const safe =
      [...calls].every((id) => results.has(id)) &&
      [...results].every((id) => calls.has(id)) &&
      !['error', 'aborted', 'pending'].includes(m.stopReason ?? '');
    points.push({
      entryId: e.id,
      hash: safe ? prefix.copy().update(']').digest('hex') : '',
      role: m.role,
      key: nativeTextKey(m.role, textOf(m.content)),
      timestamp: m.timestamp,
      safe,
    });
  }
  return points;
}
