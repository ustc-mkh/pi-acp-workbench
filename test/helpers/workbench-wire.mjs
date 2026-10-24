// Strictly v3 test peer. No event/snapshot compatibility or mutation retries.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
export class WorkbenchWire extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.requests = [];
    const lines = createInterface({ input: socket });
    lines.on('error', (error) => this.fail(error));
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'batch') return this.emit('batch', message.batch);
      if (message.type === 'resync_required') return this.emit('resync');
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        const error = new Error(`${message.code}: ${message.message}`);
        error.code = message.code;
        pending.reject(error);
      } else if (message.type === 'query') pending.resolve(message.result.value);
      else if (message.type === 'reply') pending.resolve(message.receipt);
      else if (message.type === 'image') pending.resolve(message.asset);
      else if (message.type === 'detached') pending.resolve(message.session);
      else pending.reject(new Error(`unsupported v3 response: ${message.type}`));
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('IPC closed')));
  }
  static async open(path) {
    const socket = connect(path);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new WorkbenchWire(socket);
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  call(command, operation) {
    const id = ++this.nextId;
    this.requests.push({ id, command, operation });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC timeout: ${command.method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ version: 3, id, command, operation }) + '\n');
    });
  }
  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const listener = (batch) => {
        if (predicate(batch)) {
          clearTimeout(timer);
          this.off('batch', listener);
          resolve(batch);
        }
      };
      const timer = setTimeout(() => {
        this.off('batch', listener);
        reject(new Error('revision batch timeout'));
      }, 15000);
      this.on('batch', listener);
    });
  }
  close() {
    this.socket.destroy();
  }
}
export const turnFinished = (batch, session) =>
  batch.session === session && batch.view?.status === 'Idle' && !batch.view.active_turn;
export const inlineText = (entry) => entry.text.Inline?.text;
