import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ServiceStateStream } from './service-state-stream';
const sessionSocket = () => join(homedir(), '.pi', 'pi-acp-workbench', 'service', 'sessions.sock');
const LIMIT = 16 * 1024 * 1024;
/** Client-side bounds only. The Rust service owns server limits and accounting. */
export const WIRE_LIMITS = { pending: 128, partialMs: 10000, responseBytes: 64 * 1024 * 1024 };
function reader(socket: Socket, receive: (value: any) => void) {
  socket.setEncoding('utf8');
  let buffer = '',
    bytes = 0,
    timer: NodeJS.Timeout | undefined;
  const release = () => {
    bytes = 0;
    buffer = '';
    clearTimeout(timer);
    timer = undefined;
  };
  socket.once('close', release);
  socket.on('data', (data) => {
    bytes += Buffer.byteLength(data);
    if (bytes > LIMIT) {
      socket.destroy(new Error('会话消息缓冲已满'));
      release();
      return;
    }
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      bytes -= Buffer.byteLength(line) + 1;
      try {
        receive(JSON.parse(line));
      } catch {
        socket.destroy(new Error('会话协议无效'));
        release();
        return;
      }
      if (socket.destroyed) {
        release();
        return;
      }
    }
    if (!buffer) {
      clearTimeout(timer);
      timer = undefined;
    } else {
      buffer = Buffer.from(buffer).toString('utf8');
      if (!timer) {
        timer = setTimeout(
          () => socket.destroy(new Error('会话消息未完整发送')),
          WIRE_LIMITS.partialMs,
        );
        timer.unref();
      }
    }
  });
}
/** Responses are fragmented, requests remain single bounded frames. */
function responseReader(socket: Socket, receive: (value: any) => void) {
  let parts: string[] = [],
    bytes = 0,
    timer: NodeJS.Timeout | undefined;
  const reset = () => {
    parts = [];
    bytes = 0;
    clearTimeout(timer);
    timer = undefined;
  };
  socket.once('close', reset);
  reader(socket, (item) => {
    if (item && Object.hasOwn(item, 'fragment')) {
      if (
        typeof item.fragment !== 'string' ||
        !item.fragment.length ||
        typeof item.last !== 'boolean' ||
        parts.length >= 2048
      )
        throw new Error('无效分块');
      bytes += Buffer.byteLength(item.fragment);
      if (bytes > WIRE_LIMITS.responseBytes) throw new Error('响应过大');
      parts.push(item.fragment);
      clearTimeout(timer);
      if (item.last) {
        const text = parts.join('');
        reset();
        receive(JSON.parse(text));
      } else {
        timer = setTimeout(
          () => socket.destroy(new Error('会话响应未完整发送')),
          WIRE_LIMITS.partialMs,
        );
        timer.unref();
      }
    } else {
      if (parts.length) throw new Error('分块响应交错');
      receive(item);
    }
  });
}
function encode(value: unknown) {
  const body = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(body) > LIMIT) throw new Error('会话消息过大');
  return body;
}
function sendBody(socket: Socket, body: string) {
  if (socket.destroyed) return;
  if (socket.writableLength + Buffer.byteLength(body) > LIMIT) {
    socket.destroy();
    return;
  }
  socket.write(body);
}
export class SessionClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private closed = false;
  private states = new ServiceStateStream();
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  constructor(
    private path = sessionSocket(),
    private event: (value: any) => void = () => {},
    private lost: (error: string) => void = () => {},
  ) {}
  private connect() {
    if (this.closed) return Promise.reject(new Error('会话客户端已关闭'));
    return (this.connecting ||= new Promise<void>((resolve, reject) => {
      const socket = (this.socket = createConnection(this.path));
      const timer = setTimeout(() => socket.destroy(new Error('连接超时')), 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(timer);
        const error = new Error(
          'Pi 会话服务连接已断开。请检查 pi-sessions.service；任务不会自动重发。',
        );
        reject(error);
        this.states.clear();
        this.connecting = undefined;
        this.socket = undefined;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (!this.closed) this.lost(error.message);
      });
      responseReader(socket, (item) => {
        if (item.event) {
          this.event(this.states.receive(item.event));
          return;
        }
        const pending = this.pending.get(item.id);
        if (!pending) return;
        this.pending.delete(item.id);
        clearTimeout(pending.timer);
        item.error
          ? pending.reject(Object.assign(new Error(item.error), { code: item.code }))
          : pending.resolve(item.value);
      });
    }));
  }
  watch(sessionId: string, enabled = true) {
    this.states.clear(sessionId);
    return this.call('_watch', { sessionId, enabled, stateDeltas: true });
  }
  async call<T = any>(
    method: string,
    params: unknown = {},
    id: string = randomUUID(),
    timeout = 30000,
  ): Promise<T> {
    await this.connect();
    if (this.closed || !this.socket || this.socket.destroyed) throw new Error('会话连接已关闭');
    if (this.pending.size >= WIRE_LIMITS.pending) throw new Error('会话客户端待处理请求已满');
    const body = encode({ id, method, params });
    return new Promise((resolve, reject) => {
      if (this.pending.has(id)) {
        reject(new Error('请求仍在等待'));
        return;
      }
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(
              new Error(
                `会话服务请求超时（${method}，等待 ${timeout / 1000} 秒）；请查看状态，不会自动重发。`,
              ),
            );
          }, timeout)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      sendBody(this.socket!, body);
    });
  }
  /** Free a slot after the caller gives up; late service replies are ignored. */
  cancelPending(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error('会话请求已被客户端放弃，服务端结果将被忽略。'));
  }
  dispose() {
    this.closed = true;
    this.states.clear();
    this.socket?.destroy();
  }
}
