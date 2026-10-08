import type { TerminalOutput } from './shared';
const LIMIT = 1024 * 1024;
/** Pi/Zed terminal metadata carries deltas, independently of ACP content replacements. */
export function mergeTerminalOutput(
  previous: TerminalOutput | undefined,
  meta: unknown,
): TerminalOutput | undefined {
  if (!meta || typeof meta !== 'object') return previous;
  const fields = meta as Record<string, any>;
  const info = fields.terminal_info,
    chunk = fields.terminal_output,
    exit = fields.terminal_exit;
  const id = info?.terminal_id ?? chunk?.terminal_id ?? exit?.terminal_id;
  if (typeof id !== 'string' || !id) return previous;
  const result: TerminalOutput = previous?.id === id ? { ...previous } : { id, output: '' };
  if (typeof info?.cwd === 'string') result.cwd = info.cwd;
  if (chunk?.terminal_id === id && typeof chunk.data === 'string') {
    const output = result.output + chunk.data;
    result.output = output.slice(-LIMIT);
    // Do not leave a split UTF-16 surrogate at the retained boundary.
    if (/^[\uDC00-\uDFFF]/.test(result.output)) result.output = result.output.slice(1);
    if (output.length > LIMIT) result.truncated = true;
  }
  if (exit?.terminal_id === id) {
    if (exit.exit_code === null || Number.isFinite(exit.exit_code))
      result.exitCode = exit.exit_code;
    if (exit.signal === null || typeof exit.signal === 'string') result.signal = exit.signal;
  }
  return result;
}
