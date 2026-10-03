import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('fails closed for missing or duplicate upstream patch targets', () => {
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {replaceExactlyOnce} from './scripts/build-adapter.mjs';
    assert.equal(replaceExactlyOnce('before target after','target','replacement'),'before replacement after');
    assert.throws(()=>replaceExactlyOnce('missing','target','x'), /integration seam changed/);
    assert.throws(()=>replaceExactlyOnce('target target','target','x'), /integration seam changed/);
  `], {stdio:'pipe'})).not.toThrow();
});
