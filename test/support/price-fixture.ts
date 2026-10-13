import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePricePreferences } from '../../src/price-preferences';
const roots: string[] = [];
const stores = new WeakMap<object, FilePricePreferences>();
export function priceFixture(key?: object) {
  if (key && stores.has(key)) return stores.get(key)!;
  const root = mkdtempSync(join(tmpdir(), 'pi-price-fixture-'));
  roots.push(root);
  const store = new FilePricePreferences(join(root, 'price-overrides.json'));
  if (key) stores.set(key, store);
  return store;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
