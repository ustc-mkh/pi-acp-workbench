import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export interface AgentOptions {
  requestTimeoutMs?: number; command: string; args: string[]; cwd: string; env?: Record<string, string>;
  update: (notification: acp.SessionNotification) => void;
  permission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  log: (text: string) => void; closed: (error: string) => void;
}
/** Standard ACP v1, newline-delimited JSON-RPC over child-process stdio. */
export class AgentProcess {
  private child: ChildProcessWithoutNullStreams;
  readonly connection: acp.ClientConnection;
  info?: acp.InitializeResponse;
  private disposed = false;
  private exited = false;
  get isClosed() { return this.disposed; }
  constructor(private options: AgentOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    this.child.stderr.setEncoding('utf8').on('data', options.log);
    // The SDK owns stdout; diagnostics belong on stderr, never on the protocol stream.
    this.connection = acp.client({ name: 'pi-acp-workbench' })
      .onNotification('session/update', ({ params }) => options.update(params))
      .onRequest('session/request_permission', ({ params }) => options.permission(params))
      .connect(acp.ndJsonStream(
        Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
        { maxMessageBytes: 16 * 1024 * 1024 },
      ));
    this.child.on('error', error => this.fail(`无法启动 ACP 进程：${error.message}。请检查 piAcp.command 和 PATH。`));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.fail(`ACP 进程退出 (${signal || code})。请查看 Pi Agent 日志。`);
    });
    this.child.stdin.on('error', error => this.fail(error.message));
    void this.connection.closed.then(() => this.fail('ACP 连接已关闭。'));
  }
  private fail(message: string) {
    if (this.disposed) return;
    this.dispose(); this.options.closed(message);
  }
  async initialize() {
    try {
      this.info = await this.withTimeout(this.connection.agent.request('initialize', {
        protocolVersion: 1, clientInfo: { name: 'pi-acp-workbench', title: 'Pi ACP Workbench', version: '0.2.2' },
        // Pi performs its own local file and terminal operations. Do not advertise unimplemented delegation.
        clientCapabilities: {},
      }), this.options.requestTimeoutMs ?? 20000);
      if (this.info.protocolVersion !== 1) throw new Error(`不支持 ACP 协议版本 ${this.info.protocolVersion}`);
      return this.info;
    } catch (error) { this.dispose(); throw error; }
  }
  async createSession(id?: string): Promise<acp.NewSessionResponse> {
    const params = { cwd: this.options.cwd, mcpServers: [] };
    if (id) {
      if (!this.info?.agentCapabilities?.loadSession) throw new Error('此 Agent 未声明 session/load 能力，无法恢复远端会话。');
      const result = await this.withTimeout(this.connection.agent.request('session/load', { ...params, sessionId: id }));
      return { ...result, sessionId: id };
    }
    return this.withTimeout(this.connection.agent.request('session/new', { cwd: params.cwd, mcpServers: [] }));
  }
  withTimeout<T>(request: Promise<T>, ms = this.options.requestTimeoutMs ?? 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ACP 请求超过 ${ms / 1000} 秒，连接已关闭。`));
        this.fail('ACP 请求超时，连接已关闭。');
      }, ms);
      request.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  prompt(sessionId: string, prompt: acp.ContentBlock[]) {
    return this.connection.agent.request('session/prompt', { sessionId, prompt });
  }
  cancel(sessionId: string) { return this.connection.agent.notify('session/cancel', { sessionId }); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.close();
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    const pid = this.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      if (!this.exited) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => this.child.kill());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 1500);
      timer.unref();
    }
  }
}
