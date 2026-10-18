import type { Buffer } from 'node:buffer';

export interface OperationRecord {
  operation: string;
  fingerprint: string;
  status: string;
  result: Buffer | null;
  checksum: string | null;
}
/** Independent read-only SQL inspection for isolated test fixtures only. */
export function operationRecords(root: string, operation?: string): OperationRecord[];
export interface ArchiveImageRef {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
}
export function imageArchive(
  root: string,
  id: string,
): { format_version: 1; image: ArchiveImageRef; data: string };
export function noticeText(root: string, id: string): string;
export function contentText(
  root: string,
  reference: { id: string; kind: string; sha256: string; bytes: number },
): string;
export function deliveryRecords(root: string): Array<{
  event: {
    id: string;
    revision: number;
    target: Record<string, unknown>;
    payload: Record<string, unknown>;
  };
  target_key: string;
  sequence: number;
  status: string;
  attempt: number;
  retry_at: number;
  last_failure: string | null;
}>;
export function archivedEntry(
  root: string,
  id: string,
): { id: string; text: string; image?: ArchiveImageRef | null };
