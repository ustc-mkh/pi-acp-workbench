import { expect,it } from 'vitest';
import { allocateSessionNumber,migrateSessionNumbers,sessionLabel,type SessionNumberIndex } from '../src/session-numbers';
import type { Snapshot } from '../src/shared';
const snapshot=(id:string,updated=1):Snapshot=>({id,cwd:'/project',title:'same title',updated,entries:[]});
it('migrates old histories once in stable chronological order',()=>{
  const index:SessionNumberIndex={sessions:[snapshot('later',2),snapshot('earlier',1)]};
  expect(migrateSessionNumbers(index)).toBe(true);
  expect(index.sessions.map(s=>s.sessionNumber)).toEqual([2,1]);
  index.sessions.reverse();index.sessions[0].updated=100;
  expect(migrateSessionNumbers(index)).toBe(false);
  expect(index.sessions.map(s=>s.sessionNumber)).toEqual([1,2]);
  expect(sessionLabel(2)).toBe('#002');expect(sessionLabel(undefined,'legacy')).toBe('ID legacy');
});
it('restores a number dropped from a snapshot by an older client',()=>{
  const index:SessionNumberIndex={sessions:[snapshot('one')],nextSessionNumber:8,sessionNumbers:{one:7}};
  migrateSessionNumbers(index);
  expect(index.sessions[0].sessionNumber).toBe(7);
  expect(allocateSessionNumber(index,snapshot('two'))).toBe(8);
});
it('gives branches distinct numbers and preserves logical replacements',()=>{
  const index:SessionNumberIndex={sessions:[{...snapshot('parent'),conversationId:'logical',sessionNumber:1}],nextSessionNumber:2};
  expect(allocateSessionNumber(index,{...snapshot('replacement'),conversationId:'logical'})).toBe(1);
  expect(allocateSessionNumber(index,snapshot('branch'))).toBe(2);
  index.sessions=[];
  expect(allocateSessionNumber(index,snapshot('after-clear'))).toBe(3);
});
