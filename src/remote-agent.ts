import { randomUUID } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentOptions, AgentProcess } from './agent';
import { SessionClient } from './session-wire';
import type { ServiceState } from './session-protocol';
export type Agent = Pick<
  AgentProcess,
  | 'harness'
  | 'info'
  | 'isClosed'
  | 'initialize'
  | 'createSession'
  | 'request'
  | 'withTimeout'
  | 'prompt'
  | 'cancel'
  | 'dispose'
>;
/** ACP-shaped UI facade; disposing it only detaches the client. */
export class RemoteAgent implements Agent {
  readonly harness = 'pi' as const;
  info?: acp.InitializeResponse;
  isClosed = false;
  latest?: ServiceState;
  private client: SessionClient;
  private id?: string;
  private pendingIds = new WeakMap<Promise<unknown>, string>();
  constructor(
    private options: AgentOptions,
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
          options.update(event.notification);
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
    return (this.info = await this.client.call<acp.InitializeResponse>('hello'));
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
      const snapshot = await this.client.call('create', { cwd: this.options.cwd }, undefined, 0);
      id = snapshot.id;
    }
    if (this.id && this.id !== id) await this.client.watch(this.id, false);
    this.id = id;
    await this.client.watch(id!);
    const current = await this.sync();
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
  request(method: string, params: any = {}): Promise<any> {
    const id = randomUUID(),
      result = this.client.call('request', { sessionId: params.sessionId, method, params }, id, 0);
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
