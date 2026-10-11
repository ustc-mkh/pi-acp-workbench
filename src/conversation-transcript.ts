import type { ChatState } from './shared';
import type { SessionClient } from './session-wire';
interface TranscriptHost {
  readonly state: ChatState;
  readonly generation: number;
  readonly serviceClient: Pick<SessionClient, 'call'>;
  emit(): void;
}
/** Export explicitly loads older pages without changing the visible transcript. */
export async function exportEntries(host: TranscriptHost) {
  const { generation, state } = host;
  const sessionId = state.sessionId;
  let remaining = state.historyBefore ?? 0;
  let entries = state.entries;
  const pages = [entries];
  while (remaining > 0 && sessionId && entries.length) {
    const page = await host.serviceClient.call('historyPage', {
      sessionId,
      beforeId: entries[0].id,
    });
    if (generation !== host.generation || sessionId !== host.state.sessionId)
      throw new Error('会话已切换，导出已取消。');
    if (page.remaining >= remaining || !page.entries.length)
      throw new Error('历史分页未推进，导出已取消。');
    remaining = page.remaining;
    entries = page.entries;
    pages.push(entries);
  }
  return pages.reverse().flat();
}

/** Explicit history paging; stale replies never attach to a different session. */
export async function loadEarlier(host: TranscriptHost, sessionId: string) {
  const { generation, state } = host;
  const beforeId = state.entries[0]?.id;
  if (state.sessionId !== sessionId || !beforeId || !state.historyBefore) return;
  const page = await host.serviceClient.call('historyPage', { sessionId, beforeId });
  if (
    generation !== host.generation ||
    sessionId !== host.state.sessionId ||
    beforeId !== host.state.entries[0]?.id
  )
    return;
  if (page.remaining >= state.historyBefore) throw new Error('历史分页未推进，请刷新会话。');
  host.state.entries = [...page.entries, ...host.state.entries];
  host.state.historyBefore = page.remaining;
  host.emit();
}
