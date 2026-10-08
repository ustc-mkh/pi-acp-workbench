export const HARNESS_IDS = ['pi', 'codex', 'claude'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export function isHarnessId(value: unknown): value is HarnessId {
  return HARNESS_IDS.includes(value as HarnessId);
}
export const HARNESSES: Record<
  HarnessId,
  { name: string; command: string; install: string; note: string; loginHint: string }
> = {
  pi: {
    name: 'Pi Agent',
    command: 'pi-acp',
    install: 'npm install -g @earendil-works/pi-coding-agent',
    note: 'Pi ACP：内置增强适配器，支持完整统计和上下文编辑。',
    loginHint: '使用 Pi 已保存的供应商凭据。',
  },
  codex: {
    name: 'Codex',
    command: 'codex-acp',
    install: 'npm install -g @agentclientprotocol/codex-acp',
    loginHint:
      'ChatGPT 登录需远端可用的 codex CLI（codex login）。API key 模式需设置 CODEX_API_KEY 或 OPENAI_API_KEY，并配置 DEFAULT_AUTH_REQUEST={"methodId":"api-key"}。SSH 登录方式取决于 Codex CLI 支持。',
    note: '标准 ACP（部分支持）：聊天、工具授权、图片及选择器按 Agent 能力提供；Fast mode 固定 Off、协作模式固定 Default；暂不支持 Pi 专用统计与原生分支。',
  },
  claude: {
    name: 'Claude Code',
    command: 'claude-agent-acp',
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    loginHint:
      '登录终端通过适配器的 --cli /login 打开 Claude Code；也可使用已有凭据或 ANTHROPIC_API_KEY。',
    note: '标准 ACP（部分支持）：聊天、工具授权、图片及选择器按 Agent 能力提供；暂不支持 Pi 专用统计与原生分支。',
  },
};
export function snapshotHarness(snapshot: { harness?: unknown; id?: string }): HarnessId {
  const namespace = snapshot.id?.match(/^workbench:(codex|claude):/)?.[1] as HarnessId | undefined;
  if (!isHarnessId(snapshot.harness) || (namespace && namespace !== snapshot.harness))
    throw new Error('历史记录中的 harness 不受支持或不匹配，未启动 Agent。');
  return snapshot.harness;
}
export function harnessKey(key: string, harness: HarnessId) {
  return harness === 'pi' ? key : `harness.${harness}.${key}`;
}
/** Pi uses native IDs; other adapters use a reserved local namespace. */
export function localSessionId(harness: HarnessId, id: string) {
  if (harness === 'pi') {
    if (/^workbench:(codex|claude):/.test(id))
      throw new Error('Pi 会话 ID 使用了保留的 harness 命名空间，拒绝覆盖历史。');
    return id;
  }
  return `workbench:${harness}:${encodeURIComponent(id)}`;
}
export function nativeSessionId(harness: HarnessId, id: string) {
  if (harness === 'pi') return localSessionId(harness, id);
  const prefix = `workbench:${harness}:`;
  if (!id.startsWith(prefix)) throw new Error('会话不属于当前 harness，拒绝发送。');
  return decodeURIComponent(id.slice(prefix.length));
}
