import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

/** Independent black-box client, not an alternate session service. */
export class ContractWire {
  static async open(path) {
    const socket = createConnection(path);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new ContractWire(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.fragments = [];
    this.events = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch (error) {
          socket.destroy(error);
        }
      }
    });
    socket.once('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('contract connection closed'));
      }
      this.pending.clear();
    });
  }
  receive(item) {
    if (Object.hasOwn(item, 'fragment')) {
      this.fragments.push(item.fragment);
      if (item.last) {
        const body = this.fragments.join('');
        this.fragments = [];
        this.receive(JSON.parse(body));
      }
      return;
    }
    if (item.event) {
      this.events.push(item.event);
      return;
    }
    const pending = this.pending.get(item.id);
    if (!pending) return;
    this.pending.delete(item.id);
    clearTimeout(pending.timer);
    item.error
      ? pending.reject(Object.assign(new Error(item.error), { code: item.code }))
      : pending.resolve(item.value);
  }
  call(method, params = {}, id = randomUUID()) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`contract timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {
    this.socket.destroy();
  }
}
