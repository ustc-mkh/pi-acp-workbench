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
  prompt(
    sessionId: string,
    prompt: acp.ContentBlock[],
    requestId?: string,
  ): Promise<acp.PromptResponse>;
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
  private stateVersion = 0;
  private syncVersion = 0;
  private attachmentVersion = 0;
  private pendingIds = new WeakMap<Promise<unknown>, string>();
  constructor(
    private options: RemoteAgentOptions,
    private state: (value: ServiceState) => void,
    socket?: string,
  ) {
    this.client = new SessionClient(
      socket,
      (event) => {
        if (!this.isClosed && event.type === 'state' && event.snapshot.id === this.id) {
          this.stateVersion++;
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
    if ((info.agentCapabilities?._meta?.['session-service'] as { version?: number })?.version !== 4)
      throw new Error('需要支持分页历史与服务端撤回的 v4 会话服务，请升级 daemon。');
    return (this.info = info);
  }
  async sync() {
    const id = this.id,
      observed = this.stateVersion,
      request = ++this.syncVersion;
    if (id && !this.isClosed) {
      const value = await this.client.call<ServiceState>('state', { sessionId: id });
      // Replies and subscribed events have separate transport paths. A newer
      // push, sync request, attachment or disposal supersedes this read.
      if (
        !this.isClosed &&
        this.id === id &&
        observed === this.stateVersion &&
        request === this.syncVersion
      ) {
        this.latest = value;
        this.state(value);
      }
    }
    return this.latest;
  }
  async createSession(id?: string): Promise<acp.NewSessionResponse> {
    const version = ++this.attachmentVersion;
    const verify = () => {
      if (this.isClosed) throw new Error('会话客户端已关闭');
      if (version !== this.attachmentVersion) throw new Error('会话挂接已被更新的请求取代。');
    };
    verify();
    if (!id) {
      const snapshot = await this.client.call(
        'create',
        { cwd: this.options.cwd, harness: this.harness },
        undefined,
        0,
      );
      verify();
      id = snapshot.id;
    }
    const current = await this.client.call<ServiceState>('state', { sessionId: id });
    verify();
    if (current.snapshot.harness !== this.harness) throw new Error('会话不属于当前 harness。');
    if (this.id && this.id !== id) await this.client.watch(this.id, false);
    verify();
    this.id = id;
    this.stateVersion++;
    this.latest = undefined;
    await this.client.watch(id!);
    verify();
    const latest = await this.sync();
    verify();
    return {
      sessionId: id!,
      configOptions: latest?.snapshot.configs,
      modes: latest?.snapshot.modes,
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
  prompt(sessionId: string, prompt: acp.ContentBlock[], requestId?: string) {
    return this.client.call<acp.PromptResponse>('prompt', { sessionId, prompt }, requestId, 0);
  }
  async cancel(sessionId: string) {
    await this.client.call('cancel', { sessionId });
  }
  permission(permissionId: string, optionId?: string, value?: string) {
    return this.client.call<boolean>('permission', {
      sessionId: this.id,
      permissionId,
      optionId,
      value,
    });
  }
  dispose() {
    this.isClosed = true;
    this.client.dispose();
  }
}
