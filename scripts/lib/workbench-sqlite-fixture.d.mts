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
export function archivedEntry(
  root: string,
  id: string,
): { id: string; text: string; image?: ArchiveImageRef | null };
