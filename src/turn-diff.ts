/** Persisted UI metadata only: never replayed into the model's conversation. */
export interface TurnFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  before?: string;
  after?: string;
  patch?: string;
  oldMode?: number;
  newMode?: number;
  omitted?: string;
}
export interface TurnDiff {
  /** Daemon-owned immutable body, loaded only for editor previews/undo. */
  contentRef?: string;
  status: 'complete' | 'partial' | 'unavailable';
  files: TurnFileDiff[];
  warnings: string[];
}
/** Only complete, lossless regular-file snapshots can be safely reversed. */
export function turnUndoUnavailable(diff: TurnDiff): string | undefined {
  if (diff.status !== 'complete') return '本轮快照不完整，无法安全撤回。';
  if (!diff.files.length) return '本轮没有文件修改。';
  if (
    diff.files.some(
      (file) =>
        (!diff.contentRef && (file.before === undefined || file.after === undefined)) ||
        !!file.omitted ||
        !!file.before?.includes('\0') ||
        !!file.after?.includes('\0') ||
        [file.oldMode, file.newMode].some(
          (mode) => mode !== undefined && ((mode & 0o170000) !== 0o100000 || (mode & 0o7000) !== 0),
        ),
    )
  )
    return '包含未完整保存的文本、二进制文件或特殊文件，无法安全撤回。';
  return undefined;
}
export function turnDiffTitle(diff: TurnDiff): string {
  if (diff.status === 'unavailable') return '本轮修改 · 未能采集';
  const added = diff.files.reduce((n, file) => n + file.added, 0);
  const removed = diff.files.reduce((n, file) => n + file.removed, 0);
  return `本轮修改 · ${diff.files.length} 个文件 · +${added} −${removed}${diff.status === 'partial' ? '（部分结果）' : ''}`;
}
