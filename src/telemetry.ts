export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface UsageRecord extends TokenUsage {
  id: string;
  sessionId: string;
  model: string;
  timestamp: number;
  kind: string;
  reportedCost?: number;
}
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source?: string;
  updated?: string;
}
export interface Statistics {
  models?: { id: string; name: string }[];
  records: UsageRecord[];
  prices: Record<string, Price>;
  titles: Record<string, string>;
  available: boolean;
  note?: string;
}
export interface Inspection {
  forkPoints?: import('./native-branch').NativeForkPoint[];
  records: UsageRecord[];
  cursor?: number;
  context?: string;
  contextWindow?: number;
  model?: string;
  prices?: Record<string, Price>;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function validPrice(value: unknown): value is Price {
  const p = value as Price;
  return (
    !!p &&
    ['input', 'output', 'cacheRead', 'cacheWrite'].every(
      (k) => finite(p[k as keyof TokenUsage]) && p[k as keyof TokenUsage] <= 1000000,
    )
  );
}
export function validRecord(value: unknown): value is UsageRecord {
  const r = value as UsageRecord;
  return (
    !!r &&
    typeof r.id === 'string' &&
    r.id.length < 500 &&
    typeof r.sessionId === 'string' &&
    typeof r.model === 'string' &&
    r.model.length < 300 &&
    Number.isFinite(r.timestamp) &&
    r.timestamp > 0 &&
    ['input', 'output', 'cacheRead', 'cacheWrite'].every(
      (k) => Number.isSafeInteger(r[k as keyof TokenUsage]) && r[k as keyof TokenUsage] >= 0,
    ) &&
    (r.reportedCost === undefined || finite(r.reportedCost))
  );
}
export function mergeUsage(existing: UsageRecord[], incoming: UsageRecord[]): UsageRecord[] {
  const records = new Map(existing.filter(validRecord).map((r) => [r.id, r]));
  for (const r of incoming) if (validRecord(r)) records.set(r.id, r);
  return [...records.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
}
function inputTotal(r: TokenUsage) {
  return r.input + r.cacheRead + r.cacheWrite;
}
function estimateCost(r: TokenUsage, p?: Price) {
  return p
    ? (r.input * p.input +
        r.output * p.output +
        r.cacheRead * p.cacheRead +
        r.cacheWrite * p.cacheWrite) /
        1e6
    : undefined;
}
export function priceFor(model: string, prices: Record<string, Price>) {
  // Provider-specific overrides win. Generic presets only apply to direct providers.
  if (Object.hasOwn(prices, model)) return prices[model];
  const [provider, ...name] = model.split('/');
  if (
    ['openai', 'openai-codex', 'anthropic', 'google'].includes(provider) &&
    Object.hasOwn(prices, name.join('/'))
  )
    return prices[name.join('/')];
  return undefined;
}
export function dayKey(timestamp: number) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export interface UsageGroup extends TokenUsage {
  key: string;
  calls: number;
  totalInput: number;
  cacheRate: number | undefined;
  cost: number;
  unpriced: number;
  reportedCost: number;
  unreported: number;
}
export function groupUsage(
  records: UsageRecord[],
  prices: Record<string, Price>,
  by: 'model' | 'day' | 'session',
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of records) {
    const key = by === 'model' ? r.model : by === 'day' ? dayKey(r.timestamp) : r.sessionId;
    const g = groups.get(key) || {
      key,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 0,
      cacheRate: undefined,
      cost: 0,
      unpriced: 0,
      reportedCost: 0,
      unreported: 0,
    };
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      g[field] += r[field];
    g.calls++;
    g.totalInput += inputTotal(r);
    g.cacheRate = g.totalInput ? g.cacheRead / g.totalInput : undefined;
    const cost = estimateCost(r, priceFor(r.model, prices));
    if (cost === undefined) g.unpriced++;
    else g.cost += cost;
    if (r.reportedCost === undefined) g.unreported++;
    else g.reportedCost += r.reportedCost;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    by === 'day' ? b.key.localeCompare(a.key) : b.totalInput + b.output - a.totalInput - a.output,
  );
}
