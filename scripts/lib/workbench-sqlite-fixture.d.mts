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
