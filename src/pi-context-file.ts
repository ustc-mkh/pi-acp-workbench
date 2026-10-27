import { mkdirSync, readFileSync, realpathSync, lstatSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { lockSync } from 'proper-lockfile';
import { writeAtomicFileSync } from './atomic-json';
export function piModelsConfigPath(
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
) {
  const expanded =
    agentDir === '~'
      ? homedir()
      : /^~[\\/\\\\]/.test(agentDir)
        ? join(homedir(), agentDir.slice(2))
        : agentDir;
  return join(resolve(expanded), 'models.json');
}
export const validContextWindow = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100000000;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function updateModelContextLocked(file: string, model: string, value: number | null) {
  const at = model.indexOf('/');
  const provider = model.slice(0, at),
    id = model.slice(at + 1);
  if (
    at <= 0 ||
    !id ||
    ['__proto__', 'constructor', 'prototype'].includes(provider) ||
    ['__proto__', 'constructor', 'prototype'].includes(id) ||
    (value !== null && !validContextWindow(value))
  )
    throw new Error('模型或 context 长度无效。');
  const before = contextFileBody(file);
  let config: unknown = {};
  try {
    config = before === null ? {} : JSON.parse(before);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Pi models.json 无法读取，未覆盖原文件。');
  }
  if (!object(config) || (config.providers !== undefined && !object(config.providers)))
    throw new Error('Pi models.json 格式无效，未覆盖原文件。');
  const providers = config.providers || {};
  if (!object(providers)) throw new Error('Pi providers 无效。');
  const p = providers[provider] || {};
  if (!object(p) || (p.modelOverrides !== undefined && !object(p.modelOverrides)))
    throw new Error('Pi 模型配置无效。');
  const overrides = p.modelOverrides || {};
  if (!object(overrides)) throw new Error('Pi 模型覆盖配置无效。');
  const previous = overrides[id] || {};
  if (!object(previous)) throw new Error('Pi 模型覆盖配置无效。');
  const next = { ...previous };
  if (value === null) delete next.contextWindow;
  else next.contextWindow = value;
  if (Object.keys(next).length) overrides[id] = next;
  else delete overrides[id];
  if (Object.keys(overrides).length) p.modelOverrides = overrides;
  else delete p.modelOverrides;
  if (Object.keys(p).length) providers[provider] = p;
  else delete providers[provider];
  config.providers = providers;
  writeAtomicFileSync(file, JSON.stringify(config, null, 2) + '\n', true, () => {
    if (contextFileBody(file) !== before)
      throw new Error('Pi models.json 在写入期间被其他程序修改，未覆盖。');
  });
}
export function contextFileBody(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function canonicalContextFile(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(file)), basename(file));
  try {
    const meta = lstatSync(canonical);
    if (meta.isSymbolicLink()) {
      const target = realpathSync(canonical);
      if (!statSync(target).isFile()) throw new Error('Pi models.json 必须指向普通文件。');
      return target;
    }
    if (!meta.isFile()) throw new Error('Pi models.json 必须是普通文件。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return canonical;
}
export function setModelContextFile(file: string, model: string, value: number | null) {
  file = canonicalContextFile(file);
  const release = lockSync(file, { realpath: false, stale: 30000 });
  try {
    updateModelContextLocked(file, model, value);
  } finally {
    release();
  }
}
