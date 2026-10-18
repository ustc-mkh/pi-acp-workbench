import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeForkPoints, nativePrefixHash } from '../src/native-branch';
const directory = join(process.cwd(), 'test/fixtures/native-branch');
for (const file of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
  const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8'));
  it(`preserves frozen native branch fixture: ${fixture.name}`, () => {
    expect(fixture.kind).toBe('points');
    if (fixture.expected.error)
      expect(() => nativeForkPoints(fixture.entries)).toThrow(fixture.expected.error);
    else {
      expect(nativeForkPoints(fixture.entries)).toEqual(fixture.expected.forkPoints);
      expect(nativePrefixHash(fixture.entries)).toEqual(fixture.expected.prefixHash);
    }
  });
}
