import type { Snapshot } from './shared';
export interface SessionNumberIndex { sessions: Snapshot[]; nextSessionNumber?: number; sessionNumbers?: Record<string,number> }
const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Numbers identify logical conversations, not replaceable backend ACP sessions. */
export function allocateSessionNumber(index: SessionNumberIndex, snapshot: Snapshot): number {
  const logical = snapshot.conversationId || snapshot.id;
  const numbers = index.sessionNumbers ||= {};
  if (Object.hasOwn(numbers,logical) && valid(numbers[logical])) return numbers[logical];
  const existing = index.sessions.find(s => (s.conversationId || s.id) === logical && valid(s.sessionNumber));
  let number = existing?.sessionNumber;
  if (!number) {
    const floor = Object.values(numbers).reduce((n,value)=>valid(value)?Math.max(n,value+1):n,valid(index.nextSessionNumber)?index.nextSessionNumber:1);
    number = index.sessions.reduce((n,s)=>valid(s.sessionNumber)?Math.max(n,s.sessionNumber+1):n,floor);
    if (!Number.isSafeInteger(number+1)) throw new Error('会话编号已超过安全范围。');
    index.nextSessionNumber = number+1;
  }
  Object.defineProperty(numbers,logical,{value:number,enumerable:true,writable:true,configurable:true});
  return number;
}

export function migrateSessionNumbers(index: SessionNumberIndex): boolean {
  let changed = false;
  for (const snapshot of [...index.sessions].sort((a,b)=>a.updated-b.updated || a.id.localeCompare(b.id))) {
    const logical = snapshot.conversationId || snapshot.id;
    const registered = index.sessionNumbers && Object.hasOwn(index.sessionNumbers,logical) && valid(index.sessionNumbers[logical]);
    const number = allocateSessionNumber(index,snapshot);
    if (snapshot.sessionNumber !== number || !registered) changed = true;
    snapshot.sessionNumber = number;
  }
  return changed;
}
export function sessionLabel(number?:number, id?:string) {
  return valid(number) ? `#${String(number).padStart(3,'0')}` : id ? `ID ${id}` : '';
}
