import type * as acp from '@agentclientprotocol/sdk';
import { codexFixedConfigs } from './session-settings';
import { RemoteAgent } from './remote-agent';
import { checkPromptSize } from './context';
import type { UiMessage } from './shared';
import type * as vscode from 'vscode';
import type { ActiveConversation } from './active-conversation';
import type { ConversationLifecycle } from './conversation-lifecycle';
import type { HarnessId } from './harness';

export interface TurnHost {
  readonly state: ActiveConversation['state'];
  readonly agent: ActiveConversation['agent'];
  readonly generation: number;
  readonly lifecycle: Pick<ConversationLifecycle, 'beginTurn' | 'prompt' | 'finishTurn' | 'cancel'>;
  readonly view?: vscode.WebviewView;
  readonly stopping: boolean;
  readonly harness: HarnessId;
  emit(): void;
  refreshHistory(): Promise<void>;
  refreshTelemetry(settledTurn?: boolean): Promise<void>;
}

/** Coordinates turn submission, settings, cancellation and permissions using the current UI state. */
export class TurnCoordinator {
  constructor(private readonly host: TurnHost) {}

  async onSend(message: UiMessage & { type: 'send' }): Promise<void> {
    if (
      typeof message.text !== 'string' ||
      (!message.text.trim() && !this.host.state.attachments.some((a) => a.kind === 'image'))
    )
      return;
    if (message.text.length > 500000) throw new Error('消息过长。');
    if (!this.host.agent || !this.host.state.sessionId || this.host.state.status !== 'ready')
      throw new Error('请先连接 Agent 或从历史记录恢复会话。');
    if (
      this.host.state.attachments.some((a) => a.kind === 'image') &&
      !this.host.agent.info?.agentCapabilities?.promptCapabilities?.image
    )
      throw new Error('当前 Agent 未声明图片支持，请切换支持图片的 Agent。');
    const agent = this.host.agent,
      generation = this.host.generation;
    if (generation !== this.host.generation || agent !== this.host.agent)
      throw new Error('连接状态已改变，请重试。');
    const prompt: acp.ContentBlock[] = message.text.trim()
      ? [{ type: 'text', text: message.text }]
      : [];
    const attached = this.host.state.attachments;
    for (const a of attached) {
      if (a.kind === 'image') {
        prompt.push({ type: 'image', data: a.data, mimeType: a.mimeType });
        continue;
      }
      if (agent.info?.agentCapabilities?.promptCapabilities?.embeddedContext)
        prompt.push({
          type: 'resource',
          resource: { uri: a.uri, mimeType: 'text/plain', text: a.text },
        });
      else
        prompt.push({
          type: 'text',
          text: `\n附加代码上下文：${a.name} (${a.uri})\n${a.text}`,
        });
    }
    checkPromptSize(prompt);
    this.host.state.attachments = [];
    this.host.state.status = 'busy';
    this.host.lifecycle.beginTurn();
    this.host.emit();
    try {
      await this.host.refreshHistory();
      if (generation !== this.host.generation) return;
      await this.host.view?.webview.postMessage({ type: 'sent' });
      if (this.host.stopping || generation !== this.host.generation) {
        if (generation === this.host.generation) {
          await (agent as RemoteAgent).sync();
          this.host.state.error = '本轮已停止，消息尚未发送给 Agent。';
        }
        return;
      }
      try {
        this.host.lifecycle.prompt(true);
        if (!this.host.stopping && generation === this.host.generation)
          await agent.prompt(this.host.state.sessionId!, prompt);
      } finally {
        if (generation === this.host.generation) this.host.lifecycle.prompt(false);
      }
      await (agent as RemoteAgent).sync();
    } catch (error) {
      if (generation === this.host.generation) throw error;
    } finally {
      if (generation === this.host.generation) {
        this.host.lifecycle.finishTurn();
        this.host.lifecycle.prompt(false);
        try {
          await this.host.refreshTelemetry(true);
        } finally {
          try {
            await this.host.refreshHistory();
          } finally {
            this.host.emit();
          }
        }
      }
    }
  }

  async onMode(message: UiMessage & { type: 'mode' }): Promise<void> {
    if (!this.host.agent || !this.host.state.sessionId) return;
    if (!this.host.state.modes?.availableModes.some((m) => m.id === message.value)) return;
    this.host.state.status = 'connecting';
    this.host.emit();
    try {
      await this.host.agent.withTimeout(
        this.host.agent.request('session/set_mode', {
          sessionId: this.host.state.sessionId,
          modeId: message.value,
        }),
        15000,
      );
      this.host.state.modes.currentModeId = message.value;
      await this.host.refreshHistory();
    } finally {
      this.host.state.status = this.host.agent ? 'ready' : 'disconnected';
    }
  }

  async onConfig(message: UiMessage & { type: 'config' }): Promise<void> {
    if (!this.host.agent || !this.host.state.sessionId) return;
    if (this.host.harness === 'codex' && Object.hasOwn(codexFixedConfigs, message.id))
      throw new Error('此选项已隐藏并使用默认协作模式 Default。');
    const config = this.host.state.configs?.find((c) => c.id === message.id);
    if (!config || config.type !== 'select') return;
    const options = config.options.flatMap((o) => ('options' in o ? o.options : [o]));
    if (!options.some((o) => o.value === message.value)) return;
    await this.applyConfig(message.id, message.value);
  }
  async onModelContext(message: UiMessage & { type: 'setModelContext' }): Promise<void> {
    if (
      message.harness !== 'pi' ||
      this.host.harness !== 'pi' ||
      message.sessionId !== this.host.state.sessionId
    )
      throw new Error('会话已切换或当前 Agent 不支持 context 设置。');
    if (!this.host.agent || this.host.state.status !== 'ready')
      throw new Error('请等待当前任务结束再修改 context 长度。');
    const known = this.host.state.configs?.flatMap((c) =>
      c.type === 'select' && (c.category === 'model' || c.id === 'model')
        ? c.options.flatMap((o) => ('options' in o ? o.options : [o]))
        : [],
    );
    if (!known?.some((o) => o.value === message.model)) throw new Error('模型不在当前目录中。');
    if (
      message.contextWindow !== null &&
      (!Number.isSafeInteger(message.contextWindow) ||
        message.contextWindow <= 0 ||
        message.contextWindow > 100000000)
    )
      throw new Error('context 长度必须是正整数。');
    await this.applyConfig(
      `context-window:${message.model}`,
      message.contextWindow === null ? 'default' : String(message.contextWindow),
    );
  }
  private async applyConfig(id: string, value: string): Promise<void> {
    if (!this.host.agent || !this.host.state.sessionId) return;
    this.host.state.status = 'connecting';
    this.host.emit();
    try {
      const response = await this.host.agent.withTimeout(
        this.host.agent.request('session/set_config_option', {
          sessionId: this.host.state.sessionId,
          configId: id,
          value,
        }),
        15000,
      );
      this.host.state.configs = response.configOptions;
      await this.host.refreshHistory();
      await this.host.refreshTelemetry();
    } finally {
      this.host.state.status = this.host.agent ? 'ready' : 'disconnected';
    }
  }

  async onCancel(message: UiMessage & { type: 'cancel' }): Promise<void> {
    if (!this.host.agent || this.host.state.status !== 'busy' || !this.host.state.sessionId) return;
    this.host.lifecycle.cancel();
    await this.host.agent.cancel(this.host.state.sessionId);
  }

  async onPermission(message: UiMessage & { type: 'permission' }): Promise<void> {
    if (this.host.agent)
      await (this.host.agent as RemoteAgent).permission(message.id, message.optionId);
  }
}
