// Pi provider inspection/usage extension DTOs, not a UI state or billing archive.
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
export interface Inspection {
  note?: string;
  usage?: { used: number | null; size: number };
  forkPoints?: import('./native-branch').NativeForkPoint[];
  records: UsageRecord[];
  cursor?: number;
  context?: string;
  contextWindow?: number;
  modelContexts?: Record<string, number>;
  model?: string;
  /** Omitted means unknown/unchanged; {} explicitly clears server defaults. */
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
