import { connect } from 'node:net';
import { EventEmitter } from 'node:events';

export class WorkbenchWire extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.type === 'event') this.emit('event', message.event);
        else if (message.type === 'resync_required') this.fail(new Error('IPC resync required'));
        else {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.type === 'error')
            pending.reject(new Error(`${message.code}: ${message.message}`));
          else pending.resolve(message.type === 'image' ? message.asset : message.events);
        }
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('IPC closed')));
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  static async open(path) {
    const socket = connect(path);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new WorkbenchWire(socket);
  }
  call(command, operation) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC timeout: ${command.method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ version: 2, id, operation, command }) + '\n');
    });
  }
  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.off('event', listener);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.off('event', listener);
        reject(new Error('domain event timeout'));
      }, 10000);
      this.on('event', listener);
    });
  }
  close() {
    this.socket.destroy();
  }
}
