import type { Snapshot } from './shared';
export interface SessionNumberIndex {
  sessions: Snapshot[];
  nextSessionNumber?: number;
}
const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Numbers identify logical conversations, not replaceable backend ACP sessions. */
export function allocateSessionNumber(index: SessionNumberIndex, snapshot: Snapshot): number {
  const logical = snapshot.conversationId || snapshot.id;
  const existing = index.sessions.find(
    (s) => (s.conversationId || s.id) === logical && valid(s.sessionNumber),
  );
  let number = existing?.sessionNumber;
  if (!number) {
    const floor = valid(index.nextSessionNumber) ? index.nextSessionNumber : 1;
    number = index.sessions.reduce(
      (n, s) => (valid(s.sessionNumber) ? Math.max(n, s.sessionNumber + 1) : n),
      floor,
    );
    if (!Number.isSafeInteger(number + 1)) throw new Error('会话编号已超过安全范围。');
    index.nextSessionNumber = number + 1;
  }
  return number;
}

export function sessionLabel(number?: number, id?: string) {
  return valid(number) ? `#${String(number).padStart(3, '0')}` : id ? `ID ${id}` : '';
}
