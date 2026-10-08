import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { HarnessId } from './harness';
import { SessionClient } from './session-wire';
import type { ServiceState } from './session-protocol';
export interface RemoteAgentOptions {
  cwd: string;
  harness: HarnessId;
  closed: (error: string) => void;
  update?: (notification: acp.SessionNotification) => void;
}
export interface Agent {
  readonly harness: HarnessId;
  info?: acp.InitializeResponse;
  isClosed: boolean;
  initialize(): Promise<acp.InitializeResponse>;
  createSession(id?: string): Promise<acp.NewSessionResponse>;
  request<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
  ): Promise<acp.AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(method: string, params?: Params): Promise<Response>;
  withTimeout<T>(request: Promise<T>, ms?: number): Promise<T>;
  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  dispose(): void;
}
/** ACP-shaped UI facade; disposing it only detaches the client. */
export class RemoteAgent implements Agent {
  get harness() {
    return this.options.harness;
  }
  info?: acp.InitializeResponse;
  isClosed = false;
  latest?: ServiceState;
  private client: SessionClient;
  private id?: string;
  private pendingIds = new WeakMap<Promise<unknown>, string>();
  constructor(
    private options: RemoteAgentOptions,
    private state: (value: ServiceState) => void,
    socket?: string,
  ) {
    this.client = new SessionClient(
      socket,
      (event) => {
        if (event.type === 'state' && event.snapshot.id === this.id) {
          this.latest = event;
          this.state(event);
        }
        if (event.type === 'update' && event.notification.sessionId === this.id)
          options.update?.(event.notification);
        if (event.type === 'serviceError' && event.sessionId === this.id) {
          this.isClosed = true;
          options.closed(event.error);
        }
      },
      (error) => {
        this.isClosed = true;
        options.closed(error);
      },
    );
  }
  async initialize() {
    const info = await this.client.call<acp.InitializeResponse>('hello', { harness: this.harness });
    if ((info.agentCapabilities?._meta?.['session-service'] as { version?: number })?.version !== 3)
      throw new Error('需要支持统一 harness 的 v3 会话服务，请升级 daemon。');
    return (this.info = info);
  }
  async sync() {
    if (this.id) {
      this.latest = await this.client.call<ServiceState>('state', { sessionId: this.id });
      this.state(this.latest);
    }
    return this.latest;
  }
  async createSession(id?: string): Promise<acp.NewSessionResponse> {
    if (!id) {
      const snapshot = await this.client.call(
        'create',
        { cwd: this.options.cwd, harness: this.harness },
        undefined,
        0,
      );
      id = snapshot.id;
    }
    const current = await this.client.call<ServiceState>('state', { sessionId: id });
    if (current.snapshot.harness !== this.harness) throw new Error('会话不属于当前 harness。');
    if (this.id && this.id !== id) await this.client.watch(this.id, false);
    this.id = id;
    await this.client.watch(id!);
    await this.sync();
    return {
      sessionId: id!,
      configOptions: current!.snapshot.configs,
      modes: current!.snapshot.modes,
    };
  }
  request<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
  ): Promise<acp.AgentRequestResponsesByMethod[Method]>;
  request<Response = unknown, Params = unknown>(method: string, params?: Params): Promise<Response>;
  request(method: string, params: unknown = {}): Promise<unknown> {
    const sessionId =
      params && typeof params === 'object' && 'sessionId' in params ? params.sessionId : undefined;
    const id = randomUUID(),
      result = this.client.call('request', { sessionId, method, params }, id, 0);
    this.pendingIds.set(result, id);
    return result;
  }
  async withTimeout<T>(request: Promise<T>, ms = 30000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            const id = this.pendingIds.get(request);
            if (id) this.client.cancelPending(id);
            reject(new Error('服务操作仍未完成，请查看会话状态。'));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  prompt(sessionId: string, prompt: acp.ContentBlock[]) {
    return this.client.call<acp.PromptResponse>('prompt', { sessionId, prompt }, undefined, 0);
  }
  async cancel(sessionId: string) {
    await this.client.call('cancel', { sessionId });
  }
  permission(permissionId: string, optionId?: string) {
    return this.client.call<boolean>('permission', { sessionId: this.id, permissionId, optionId });
  }
  dispose() {
    this.isClosed = true;
    this.client.dispose();
  }
}
