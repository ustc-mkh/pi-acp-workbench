import { readFileSync } from 'node:fs';
import { lock } from 'proper-lockfile';
import { writeAtomicFileSync } from './atomic-json';
import {
  canonicalContextFile,
  contextFileBody,
  updateModelContextLocked,
  validContextWindow,
} from './pi-context-file';
export class ContextProjectionError extends Error {}
export interface ContextProjection {
  owner: string;
  revision: number;
}
export const validProjection = (v: unknown): v is ContextProjection => {
  const x = v as ContextProjection;
  return (
    !!x &&
    typeof x.owner === 'string' &&
    /^[a-f0-9]{64}$/.test(x.owner) &&
    Number.isSafeInteger(x.revision) &&
    x.revision > 0
  );
};
interface Checkpoint extends ContextProjection {
  model: string;
  value: number | null;
  before: number | null;
  state: 'prepared' | 'applied';
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function valueAt(file: string, model: string): number | null {
  const body = contextFileBody(file);
  const config: unknown = body === null ? {} : JSON.parse(body);
  if (!object(config)) throw new ContextProjectionError('Pi models.json 格式无效。');
  const at = model.indexOf('/');
  const providers = config.providers;
  if (providers === undefined) return null;
  if (!object(providers)) throw new ContextProjectionError('Pi providers 格式无效。');
  const p = providers[model.slice(0, at)];
  if (p === undefined) return null;
  if (!object(p)) throw new ContextProjectionError('Pi provider 格式无效。');
  const overrides = p.modelOverrides;
  if (overrides === undefined) return null;
  if (!object(overrides)) throw new ContextProjectionError('Pi modelOverrides 格式无效。');
  const entry = overrides[model.slice(at + 1)];
  if (entry === undefined) return null;
  if (!object(entry)) throw new ContextProjectionError('Pi 模型覆盖配置无效。');
  const value = entry.contextWindow;
  if (value === undefined) return null;
  if (!validContextWindow(value)) throw new ContextProjectionError('Pi context 覆盖值无效。');
  return value;
}
function readCheckpoint(file: string): Checkpoint | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ContextProjectionError('Pi context 投影记录无法读取，未覆盖配置。');
  }
  const p = raw as Checkpoint;
  if (
    !validProjection(p) ||
    typeof p.model !== 'string' ||
    !['prepared', 'applied'].includes(p.state) ||
    (p.value !== null && !validContextWindow(p.value)) ||
    (p.before !== null && !validContextWindow(p.before))
  )
    throw new ContextProjectionError('Pi context 投影记录无效，未覆盖配置。');
  return p;
}
/** Cross-process/profile lock covers read/merge/write, registry refresh and acknowledgement.
 * Lock contenders fail closed; the SQLite pending intent is retried explicitly/on next provider use.
 */
export async function projectContext(
  file: string,
  model: string,
  value: number | null,
  projection: ContextProjection,
  apply: () => Promise<void>,
  idle?: () => boolean,
) {
  if (!validProjection(projection))
    throw new ContextProjectionError('Context 必须通过 Workbench 模型设置统一保存。');
  const source = file;
  file = canonicalContextFile(file);
  const release = await lock(file, { realpath: false, stale: 30000, update: 10000, retries: 0 });
  try {
    if (idle && !idle()) throw new ContextProjectionError('Pi 已开始运行，context 尚未应用。');
    const checkpointFile = file + '.workbench-context.json';
    let prior = readCheckpoint(checkpointFile);
    if (prior && prior.owner !== projection.owner)
      throw new ContextProjectionError(
        '该 Pi profile 已由另一个 Workbench 数据 root 管理，请使用独立 profile。',
      );
    if (prior && prior.revision > projection.revision)
      throw new ContextProjectionError('Context 配置版本已过期，拒绝旧请求。');
    if (prior?.revision === projection.revision && (prior.model !== model || prior.value !== value))
      throw new ContextProjectionError('Context 配置版本与内容不匹配。');
    if (!prior || prior.revision < projection.revision) {
      prior = { ...projection, model, value, before: valueAt(file, model), state: 'prepared' };
      writeAtomicFileSync(checkpointFile, JSON.stringify(prior) + '\n', true);
    }
    const current = valueAt(file, model);
    if (prior.state === 'applied' && current !== value)
      throw new ContextProjectionError('Pi context 在应用后被外部修改，请核对后重新保存。');
    if (prior.state === 'prepared' && current !== value && current !== prior.before)
      throw new ContextProjectionError('Pi context 与待应用记录冲突，请核对后重新保存。');
    if (current !== value) updateModelContextLocked(file, model, value);
    await apply();
    if (canonicalContextFile(source) !== file)
      throw new ContextProjectionError('Pi models.json 的目标路径已变化，未确认成功。');
    if (valueAt(file, model) !== value)
      throw new ContextProjectionError('Pi context 在刷新期间被外部修改，未确认成功。');
    const fence = readCheckpoint(checkpointFile);
    if (
      !fence ||
      fence.owner !== projection.owner ||
      fence.revision !== projection.revision ||
      fence.model !== model ||
      fence.value !== value
    )
      throw new ContextProjectionError('Pi context 投影记录已变化，未确认成功。');
    writeAtomicFileSync(
      checkpointFile,
      JSON.stringify({ ...prior, state: 'applied' }) + '\n',
      true,
    );
  } finally {
    await release();
  }
}
export async function readContextProfile(file: string, read: () => Promise<void>) {
  const source = file;
  file = canonicalContextFile(file);
  const release = await lock(file, { realpath: false, stale: 30000, update: 10000, retries: 0 });
  try {
    await read();
    if (canonicalContextFile(source) !== file)
      throw new ContextProjectionError('Pi models.json 的目标路径已变化，请重新读取。');
  } finally {
    await release();
  }
}
