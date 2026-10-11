import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePiCommand } from './pi-command';
import type { PiSession } from './pi-rpc-types';
import type { UsageRecord } from './telemetry';
import { validRecord } from './telemetry';

export const TITLE_PROMPT = '将用户任务概括为8–16字短标题，沿用用户语言。只输出标题，不执行任务。';
export function titleArgs(provider: string, model: string): string[] {
  return [
    '--mode',
    'json',
    '--print',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--provider',
    provider,
    '--model',
    model,
    '--thinking',
    'off',
    '--system-prompt',
    TITLE_PROMPT,
  ];
}
export function parseTitleOutput(output: string, sessionId: string, model: string) {
  let title = '';
  const records: UsageRecord[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
    const message = event.message;
    title = ['error', 'aborted', 'toolUse'].includes(message.stopReason)
      ? ''
      : (message.content || [])
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('');
    if (message.usage) {
      const record: UsageRecord = {
        id: `title:${records.length}`,
        sessionId,
        model,
        kind: 'session-title',
        timestamp: Date.now(),
        input: message.usage.input ?? 0,
        output: message.usage.output ?? 0,
        cacheRead: message.usage.cacheRead ?? 0,
        cacheWrite: message.usage.cacheWrite ?? 0,
      };
      if (validRecord(record)) records.push(record);
    }
  }
  title = [
    ...title
      .trim()
      .split(/\r?\n/)[0]
      .replace(/^[#*`"'“”「」\s]+|[#*`"'“”「」\s]+$/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ''),
  ]
    .slice(0, 32)
    .join('');
  return { title, records };
}
/** A tool-free, non-persistent process with no project context. Never prompt the
 * user's working conversation just to obtain a name or change its model. */
export async function generatePiTitle(session: PiSession, requestedModel: string, input: string) {
  const active = await session.proc.getState();
  const key = requestedModel || `${active.model?.provider || ''}/${active.model?.id || ''}`;
  const models = await session.proc.getAvailableModels();
  const selected = models.models?.find((model) => `${model.provider}/${model.id}` === key);
  if (!selected?.provider || !selected.id) throw new Error('标题模型不在 Pi 目录中。');
  const command = await resolvePiCommand(process.env.PI_ACP_PI_COMMAND, session.cwd);
  const cwd = await mkdtemp(join(tmpdir(), 'pi-title-'));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        command,
        titleArgs(selected.provider!, selected.id!),
        { cwd, timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 },
        (error, stdout) => (error ? reject(new Error('标题生成失败或超时。')) : resolve(stdout)),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end([...input].slice(0, 1000).join(''));
    });
    return parseTitleOutput(output, session.sessionId, key);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
