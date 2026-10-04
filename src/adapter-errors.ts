/** Keep provider HTML error pages out of chat while preserving useful plain-text errors. */
export function providerError(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return '模型请求失败，请检查模型服务、凭据及网络连接。';
  if (/<(?:html|!doctype|body)\b/i.test(message)) return '模型服务返回网页错误，未生成回复。请检查服务器的网络或代理连接。';
  return message.trim().slice(0,1000);
}
