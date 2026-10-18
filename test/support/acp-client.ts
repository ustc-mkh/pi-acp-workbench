// Independent standard ACP fixture; no workbench wire, storage or ID translation.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
type FixtureProfile = 'pi' | 'codex' | 'claude';

export interface AgentOptions {
  harness?: FixtureProfile;
  commandSetting?: string;
  requestTimeoutMs?: number;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  update: (notification: acp.SessionNotification) => void;
  permission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  log: (text: string) => void;
  closed: (error: string) => void;
}
/** Standard ACP v1, newline-delimited JSON-RPC over child-process stdio. */
export class AgentProcess {
  private child: ChildProcessWithoutNullStreams;
  private readonly home = mkdtempSync(join(tmpdir(), 'workbench-acp-fixture-home-'));
  readonly connection: acp.ClientConnection;
  info?: acp.InitializeResponse;
  readonly harness: FixtureProfile;
  private disposed = false;
  private exited = false;
  private termination: Promise<void> = Promise.resolve();
  get isClosed() {
    return this.disposed;
  }
  constructor(private options: AgentOptions) {
    this.harness = options.harness || 'pi';
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // Default fixtures never inherit accounts, Bot keys, proxies or Node hooks.
      // Opt-in SDK/live smoke drivers must explicitly provide their environment.
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        HOME: this.home,
        USERPROFILE: this.home,
        ...options.env,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child.stderr.setEncoding('utf8').on('data', options.log);
    // The SDK owns stdout; diagnostics belong on stderr, never on the protocol stream.
    this.connection = acp
      .client({ name: 'pi-acp-workbench' })
      .onNotification('session/update', ({ params }) => options.update(params))
      .onRequest('session/request_permission', ({ params }) => options.permission(params))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
          { maxMessageBytes: 16 * 1024 * 1024 },
        ),
      );
    this.child.on('error', (error) =>
      this.fail(`Cannot start ${this.harness} ACP fixture: ${error.message}`),
    );
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.fail(`ACP 进程退出 (${signal || code})。请查看 Pi Agent 日志。`);
    });
    this.child.stdin.on('error', (error) => this.fail(error.message));
    void this.connection.closed.then(() => this.fail('ACP 连接已关闭。'));
  }
  private fail(message: string) {
    if (this.disposed) return;
    this.dispose();
    this.options.closed(message);
  }
  request<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
  ): Promise<acp.AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(method: string, params?: Params): Promise<Response>;
  async request(method: string, params?: unknown): Promise<unknown> {
    return this.connection.agent.request(method, params);
  }
  async initialize() {
    try {
      this.info = await this.withTimeout(
        this.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'independent-acp-fixture', version: '1' },
          // Adapters must handle their own files/terminals. Never advertise unimplemented delegation.
          clientCapabilities: {},
        }),
        this.options.requestTimeoutMs ?? 20000,
      );
      if (this.info.protocolVersion !== 1)
        throw new Error(`不支持 ACP 协议版本 ${this.info.protocolVersion}`);
      return this.info;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async createSession(id?: string): Promise<acp.NewSessionResponse> {
    const params = { cwd: this.options.cwd, mcpServers: [] };
    if (!id) return this.withTimeout(this.request('session/new', params));
    if (!this.info?.agentCapabilities?.loadSession)
      throw new Error('此 Agent 未声明 session/load 能力，无法恢复远端会话。');
    const result = await this.withTimeout(
      this.request('session/load', { ...params, sessionId: id }),
    );
    return { ...result, sessionId: id };
  }
  withTimeout<T>(request: Promise<T>, ms = this.options.requestTimeoutMs ?? 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ACP 请求超过 ${ms / 1000} 秒，连接已关闭。`));
        this.fail('ACP 请求超时，连接已关闭。');
      }, ms);
      request.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
  prompt(sessionId: string, prompt: acp.ContentBlock[]) {
    return this.request('session/prompt', { sessionId, prompt });
  }
  cancel(sessionId: string) {
    return this.connection.agent.notify('session/cancel', {
      sessionId,
    });
  }
  /** Wait until process-group escalation has run before reusing a worker slot. */
  async stop() {
    this.dispose();
    await this.termination;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.close();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    const pid = this.child.pid;
    if (!pid) {
      rmSync(this.home, { recursive: true, force: true });
      return;
    }
    if (process.platform === 'win32') {
      this.termination = this.exited
        ? Promise.resolve()
        : new Promise((resolve) => this.child.once('exit', () => resolve()));
      if (!this.exited)
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
          'error',
          () => this.child.kill(),
        );
    } else {
      // Resolve as soon as the group exits; the timer only escalates to SIGKILL.
      this.termination = new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
          if (this.exited) finish();
          else this.child.once('exit', finish);
        }, 1500);
        timer.unref();
        if (this.exited) finish();
        else this.child.once('exit', finish);
      });
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    // Remove only our own private directory after physical child termination,
    // never options.env.HOME (which an explicit smoke driver may override).
    this.termination = this.termination.then(() => {
      rmSync(this.home, { recursive: true, force: true });
    });
  }
}
