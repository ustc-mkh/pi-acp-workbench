import { createHash, randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import {
  clientCommand,
  commandPool,
  durableCommand,
  ipcMessage,
  operationId,
  type ClientCommand,
  type CommandResult,
  type DomainEvent,
  type ImageAsset,
  type ImageRef,
  type OperationId,
} from './workbench-protocol';

export const WORKBENCH_LIMITS = {
  frameBytes: 8 * 1024 * 1024,
  pools: [16, 4, 4] as const,
  connectMs: 5000,
  partialMs: 10000,
};
export class WorkbenchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operation?: OperationId,
    /** True means losing this observer does not establish whether the host committed. */
    readonly sideEffectPossible = false,
  ) {
    super(message);
    this.name = 'WorkbenchError';
  }
}
export interface RequestOptions {
  operation?: OperationId;
  timeoutMs?: number;
}
export interface RequestTicket<C extends ClientCommand> {
  readonly id: number;
  readonly operation?: OperationId;
  readonly result: Promise<CommandResult<C>>;
  /** Drops only this observer. Never sends cancel/cancel_fork or automatically retries. */
  abandon(): void;
}
interface Pending {
  command: ClientCommand;
  operation?: OperationId;
  sent: boolean;
  settled: boolean;
  pool: 0 | 1 | 2;
  resolve(value: DomainEvent[] | ImageAsset): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}
interface Connection {
  socket: Socket;
  ready: Promise<void>;
  reject(error: Error): void;
  stopReader(): void;
}
export interface WorkbenchObserver {
  event?(event: DomainEvent): void;
  resync?(): void;
  lost?(error: WorkbenchError): void;
  observerError?(): void;
}

/** Per-frame byte bound, fatal UTF-8, and a fixed (not sliding) incomplete-frame deadline. */
function readFrames(socket: Socket, receive: (body: unknown) => void, fail: () => void) {
  let parts: Buffer[] = [],
    bytes = 0,
    timer: NodeJS.Timeout | undefined;
  const clear = () => {
    parts = [];
    bytes = 0;
    clearTimeout(timer);
    timer = undefined;
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  socket.on('data', (chunk: Buffer) => {
    try {
      for (let start = 0; start < chunk.length; ) {
        const end = chunk.indexOf(10, start),
          complete = end !== -1;
        const part = chunk.subarray(start, complete ? end : chunk.length);
        bytes += part.length;
        if (bytes > WORKBENCH_LIMITS.frameBytes) throw new Error();
        if (part.length) parts.push(part);
        if (complete) {
          if (!bytes) throw new Error();
          const line = Buffer.concat(parts, bytes);
          clear();
          receive(JSON.parse(decoder.decode(line)));
          if (socket.destroyed) return;
          start = end + 1;
        } else {
          if (!timer) {
            timer = setTimeout(fail, WORKBENCH_LIMITS.partialMs);
            timer.unref();
          }
          break;
        }
      }
    } catch {
      clear();
      fail();
    }
  });
  socket.once('close', clear);
  return clear;
}
/** Same bounded signature contract as Rust; not a full decoder or sanitizer. */
export function verifiedImage(asset: ImageAsset, expected: ImageRef): ImageAsset {
  const ref = asset.image;
  const bad = () => {
    throw new WorkbenchError('protocol', 'Invalid archived image response');
  };
  if (
    ref.id !== expected.id ||
    ref.mime !== expected.mime ||
    ref.bytes !== expected.bytes ||
    ref.sha256 !== expected.sha256
  )
    bad();
  // Buffer's base64 decoder is permissive: require a canonical roundtrip too.
  const bytes = Buffer.from(asset.data, 'base64');
  if (
    bytes.length !== ref.bytes ||
    bytes.toString('base64') !== asset.data ||
    createHash('sha256').update(bytes).digest('hex') !== ref.sha256
  )
    bad();
  const starts = (s: string) => bytes.subarray(0, s.length).equals(Buffer.from(s, 'latin1'));
  const signature = (() => {
    switch (ref.mime) {
      case 'image/png':
        return (
          bytes.length >= 24 &&
          starts('\x89PNG\r\n\x1a\n') &&
          bytes.toString('ascii', 12, 16) === 'IHDR'
        );
      case 'image/jpeg':
        return bytes.length >= 4 && starts('\xff\xd8\xff');
      case 'image/gif':
        return bytes.length >= 10 && (starts('GIF87a') || starts('GIF89a'));
      case 'image/webp':
        return bytes.length >= 16 && starts('RIFF') && bytes.toString('ascii', 8, 12) === 'WEBP';
    }
  })();
  if (!signature) bad();
  return asset;
}

/** External IPC v2 only. A fresh explicit request may reconnect; nothing is resent/re-subscribed. */
export class WorkbenchClient {
  private connection?: Connection;
  private closed = false;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private pools = [0, 0, 0];
  private observers = new Set<WorkbenchObserver>();
  constructor(
    readonly path: string,
    observer?: WorkbenchObserver,
  ) {
    if (observer) this.observers.add(observer);
  }
  observe(observer: WorkbenchObserver) {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  private notify(kind: 'event', value: DomainEvent): void;
  private notify(kind: 'lost', value: WorkbenchError): void;
  private notify(kind: 'resync'): void;
  private notify(kind: 'event' | 'lost' | 'resync', value?: DomainEvent | WorkbenchError) {
    for (const observer of [...this.observers]) {
      try {
        if (kind === 'event') observer.event?.(value as DomainEvent);
        else if (kind === 'lost') observer.lost?.(value as WorkbenchError);
        else observer.resync?.();
      } catch {
        try {
          observer.observerError?.();
        } catch {
          /* observer isolation */
        }
      }
    }
  }
  private connect(): Promise<void> {
    if (this.closed)
      return Promise.reject(new WorkbenchError('closed', 'Workbench client is closed'));
    if (this.connection) return this.connection.ready;
    let socket: Socket;
    try {
      socket = createConnection(this.path);
    } catch {
      return Promise.reject(new WorkbenchError('disconnected', 'Cannot connect to workbench'));
    }
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, fail) => {
      reject = fail;
      socket.once('connect', resolve);
    });
    const connection: Connection = { socket, ready, reject, stopReader: () => {} };
    this.connection = connection;
    const timer = setTimeout(
      () => this.fail(connection, 'disconnected', 'Workbench connection timeout'),
      WORKBENCH_LIMITS.connectMs,
    );
    timer.unref();
    socket.once('connect', () => clearTimeout(timer));
    socket.on('error', () =>
      this.fail(connection, 'disconnected', 'Workbench connection failed; requests are not resent'),
    );
    socket.once('close', () => {
      clearTimeout(timer);
      this.fail(connection, 'disconnected', 'Workbench disconnected; requests are not resent');
    });
    connection.stopReader = readFrames(
      socket,
      (value) => this.receive(value),
      () => this.fail(connection, 'protocol', 'Invalid or incomplete workbench frame'),
    );
    return ready;
  }
  private fail(connection: Connection, code: string, message: string) {
    if (this.connection !== connection) return;
    this.connection = undefined;
    const error = new WorkbenchError(code, message);
    connection.reject(error);
    connection.stopReader();
    connection.socket.destroy();
    for (const [id, pending] of this.pending) {
      this.finish(id);
      if (!pending.settled)
        pending.reject(
          new WorkbenchError(
            code,
            message,
            pending.operation,
            pending.sent && pending.operation !== undefined,
          ),
        );
    }
    if (!this.closed) this.notify('lost', error);
  }
  private finish(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.pools[pending.pool]--;
  }
  private receive(value: unknown) {
    const message = ipcMessage.parse(value);
    if (message.type === 'event') {
      this.notify('event', message.event);
      return;
    }
    if (message.type === 'resync_required') {
      this.notify('resync');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // A late reply never correlates to another request: IDs are not reused.
    let result: DomainEvent[] | ImageAsset | undefined;
    if (message.type !== 'error') {
      if (message.type === 'image' && pending.command.method === 'image') {
        result = verifiedImage(message.asset, pending.command.image);
      } else if (message.type === 'reply' && pending.command.method !== 'image') {
        result = message.events;
      } else throw new Error('Unexpected workbench response kind');
    }
    this.finish(message.id);
    if (pending.settled) return;
    if (message.type === 'error')
      pending.reject(
        new WorkbenchError(
          message.code,
          message.message,
          pending.operation,
          pending.operation !== undefined,
        ),
      );
    else pending.resolve(result!);
  }
  request<C extends ClientCommand>(command: C, options: RequestOptions = {}): RequestTicket<C> {
    if (this.closed) throw new WorkbenchError('closed', 'Workbench client is closed');
    const parsed = clientCommand.parse(command),
      pool = commandPool(parsed);
    if (
      options.operation !== undefined &&
      ['image', 'subscribe', 'unsubscribe'].includes(parsed.method)
    )
      throw new WorkbenchError(
        'invalid_input',
        'This query/subscription cannot have a durable operation',
      );
    const operation =
      options.operation !== undefined
        ? operationId.parse(options.operation)
        : durableCommand(parsed)
          ? operationId.parse(randomUUID())
          : undefined;
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    )
      throw new WorkbenchError('invalid_input', 'Invalid observer timeout', operation);
    if (this.pools[pool] >= WORKBENCH_LIMITS.pools[pool])
      throw new WorkbenchError('backpressure', 'Workbench client request pool is full', operation);
    if (this.nextId >= Number.MAX_SAFE_INTEGER)
      throw new WorkbenchError('backpressure', 'Workbench request IDs exhausted', operation);
    const id = ++this.nextId;
    const body =
      JSON.stringify({ version: 2, id, command: parsed, ...(operation ? { operation } : {}) }) +
      '\n';
    if (Buffer.byteLength(body) - 1 > WORKBENCH_LIMITS.frameBytes)
      throw new WorkbenchError('invalid_input', 'Workbench request is too large', operation);
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const result = new Promise<CommandResult<C>>((done, fail) => {
      resolve = (value) => done(value as CommandResult<C>);
      reject = fail;
    });
    const pending: Pending = {
      command: parsed,
      operation,
      pool,
      sent: false,
      settled: false,
      resolve,
      reject,
    };
    this.pending.set(id, pending);
    this.pools[pool]++;
    const abandon = (code = 'abandoned') => {
      if (this.pending.get(id) !== pending || pending.settled) return;
      pending.settled = true;
      clearTimeout(pending.timer);
      pending.reject(
        new WorkbenchError(
          code,
          'Only the request observer was abandoned; no cancellation or resend',
          operation,
          pending.sent && operation !== undefined,
        ),
      );
      // Already-sent requests retain their quota until reply/disconnect, bounding unobserved work.
      if (!pending.sent) this.finish(id);
    };
    if (options.timeoutMs) {
      pending.timer = setTimeout(() => abandon('timeout'), options.timeoutMs);
      pending.timer.unref();
    }
    void this.connect()
      .then(() => {
        if (this.pending.get(id) !== pending) return;
        const socket = this.connection?.socket;
        if (!socket || socket.destroyed) throw new Error();
        if (socket.writableLength + Buffer.byteLength(body) > WORKBENCH_LIMITS.frameBytes) {
          this.finish(id);
          if (!pending.settled)
            pending.reject(
              new WorkbenchError('backpressure', 'Workbench write queue is full', operation),
            );
          return;
        }
        pending.sent = true;
        socket.write(body);
      })
      .catch(() => {
        if (this.pending.get(id) !== pending) return;
        this.finish(id);
        if (!pending.settled)
          pending.reject(
            new WorkbenchError(
              'disconnected',
              'Workbench request could not complete; not resent',
              operation,
              pending.sent && operation !== undefined,
            ),
          );
      });
    return { id, operation, result, abandon: () => abandon() };
  }
  async call<C extends ClientCommand>(
    command: C,
    options?: RequestOptions,
  ): Promise<CommandResult<C>> {
    return this.request(command, options).result;
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (this.connection) this.fail(this.connection, 'closed', 'Workbench client is closed');
    this.observers.clear();
  }
}
