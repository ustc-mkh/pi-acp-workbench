import type { UiMessage } from './shared';
import { isHarnessId } from './harness';

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === 'string' && v.length <= 10000;
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const number: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const harness: Check = (v) => typeof v === 'string' && isHarnessId(v);
const price: Check = (v) =>
  object(v) &&
  ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => number(v[k])) &&
  optional(text)(v.source) &&
  optional(text)(v.updated);
const images: Check = (v) =>
  Array.isArray(v) &&
  v.length <= 8 &&
  Array.from(v).every(
    (i) =>
      object(i) &&
      text(i.name) &&
      text(i.mimeType) &&
      typeof i.data === 'string' &&
      i.data.length <= 8 * 1024 * 1024,
  );
const schemas: Record<UiMessage['type'], Record<string, Check>> = {
  ready: {},
  connect: {},
  new: {},
  cancel: {},
  attach: {},
  clearHistory: {},
  login: {},
  logs: {},
  preview: {},
  export: {},
  refreshStatistics: {},
  cancelContext: {},
  releaseSession: {},
  refreshHistory: {},
  attachImages: { harness: optional(harness), sessionId: optional(text), images },
  readOutputImage: { id: text, url: text, harness, sessionId: optional(text) },
  attachmentError: { harness: optional(harness), sessionId: optional(text), error: text },
  switchHarness: { harness },
  setPrice: { model: text, price: optional(price) },
  send: { text: (v) => typeof v === 'string' && v.length <= 500000 },
  dismissError: { error: text },
  permission: { id: text, optionId: optional(text) },
  mode: { value: text },
  config: { id: text, value: text },
  setVisibleModels: {
    harness,
    models: (v) =>
      v === null || (Array.isArray(v) && v.length <= 10000 && Array.from(v).every(text)),
  },
  resume: { id: text },
  removeAttachment: { id: text },
  deleteHistory: { id: text },
  branchMessage: { id: text, sessionId: text },
  diff: { id: text, index: (v) => typeof v === 'number' && Number.isInteger(v) && v >= -1 },
  open: { url: text, line: optional((v) => number(v) && Number.isInteger(v)) },
};

/** Validate untrusted webview messages before acquiring an operation gate. */
export function parseUiMessage(value: unknown): UiMessage | undefined {
  if (!object(value) || typeof value.type !== 'string' || !Object.hasOwn(schemas, value.type))
    return;
  const schema = schemas[value.type as UiMessage['type']];
  for (const [key, check] of Object.entries(schema))
    if (!check(value[key])) throw new Error(`消息参数无效：${value.type}.${key}`);
  return value as UiMessage;
}
