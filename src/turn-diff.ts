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
  status: 'complete' | 'partial' | 'unavailable';
  files: TurnFileDiff[];
  warnings: string[];
}
export function turnDiffTitle(diff: TurnDiff): string {
  if (diff.status === 'unavailable') return '本轮修改 · 未能采集';
  const added = diff.files.reduce((n, file) => n + file.added, 0);
  const removed = diff.files.reduce((n, file) => n + file.removed, 0);
  return `本轮修改 · ${diff.files.length} 个文件 · +${added} −${removed}${diff.status === 'partial' ? '（部分结果）' : ''}`;
}
