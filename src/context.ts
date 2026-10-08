import type * as acp from '@agentclientprotocol/sdk';

export function checkPromptSize(prompt: acp.ContentBlock[]) {
  // Leave room for JSON-RPC framing below the SDK's 16 MiB limit, including escaping.
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > 12 * 1024 * 1024) {
    throw new Error('消息和附件超过 12 MiB，未发送。请减少输入内容。');
  }
}
