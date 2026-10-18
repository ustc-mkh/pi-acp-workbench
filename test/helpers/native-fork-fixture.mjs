// Synthetic native context store, not Pi/SDK native-history compatibility.
// Each peer owns one session file; branching writes a distinct immutable prefix
// without modifying the source file. No credentials or model calls are used.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const digest = (value) => createHash('sha256').update(value).digest('hex');
export class NativeForkFixture {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  path(id) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('invalid fixture session');
    return join(this.root, `${id}.json`);
  }
  read(id) {
    const state = JSON.parse(readFileSync(this.path(id), 'utf8'));
    if (state.id !== id) throw new Error('fixture native identity mismatch');
    return state;
  }
  write(state) {
    const path = this.path(state.id);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
  }
  create(id, model, mode) {
    this.write({ id, model, mode, entries: [] });
  }
  configure(id, model, mode) {
    const state = this.read(id);
    state.model = model;
    state.mode = mode;
    this.write(state);
  }
  record(id, role, text, model, mode, stream) {
    const state = this.read(id);
    const previous = state.entries.at(-1);
    if (stream && previous?.role === role && previous.stream === stream) previous.text += text;
    else
      state.entries.push({
        id: randomUUID(),
        role,
        text,
        model,
        mode,
        ...(stream ? { stream } : {}),
      });
    this.write(state);
  }
  points(id) {
    const { entries } = this.read(id);
    return entries.map((entry, index) => ({
      entryId: entry.id,
      hash: digest(JSON.stringify(entries.slice(0, index + 1))),
      role: entry.role,
      key: `${entry.role}:${digest(entry.text)}`,
      safe: true,
    }));
  }
  fork(id, entryId, hash) {
    const state = this.read(id);
    const points = this.points(id);
    const index = points.findIndex((point) => point.entryId === entryId && point.hash === hash);
    if (index < 0) throw new Error('fixture fork prefix mismatch');
    const entry = state.entries[index];
    const fork = {
      id: randomUUID(),
      model: entry.model,
      mode: entry.mode,
      entries: state.entries.slice(0, index + 1),
    };
    this.write(fork);
    return fork.id;
  }
}
