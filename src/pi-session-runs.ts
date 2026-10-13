import { randomUUID } from 'node:crypto';

/** Narrow boundary to the pinned adapter. A settled event detaches its promise
 * BEFORE metadata I/O: a later extension wake must never resolve a newer prompt. */
interface Turn {
  resolve(reason: string): void;
  reject(error: unknown): void;
  workbenchCancelled?: () => boolean;
}
interface Session {
  sessionId: string;
  pendingTurn: Turn | null;
  turnQueue: Turn[];
  cancelRequested: boolean;
  modelError?: string;
  inAgentLoop: boolean;
  proc: {
    getState(): Promise<{ isStreaming?: boolean; isCompacting?: boolean }>;
    request(command: { type: string }): Promise<unknown>;
    abort(): Promise<void>;
  };
  emit(update: unknown): void;
  publishContextUsage(): Promise<void>;
  startTurn(turn: Turn): void;
}
interface Run {
  id: string;
  autonomous: boolean;
  userStarted?: boolean;
}
interface State {
  run?: Run;
  settling: number;
  messageId?: string;
}
const states = new WeakMap<Session, State>();
function state(session: Session): State {
  let value = states.get(session);
  if (!value) states.set(session, (value = { settling: 0 }));
  return value;
}
function lifecycle(
  session: Session,
  run: Run,
  running: boolean,
  error?: string,
  cancelled = false,
) {
  session.emit({
    sessionUpdate: 'session_info_update',
    _meta: {
      'pi-workbench-run': {
        id: run.id,
        autonomous: run.autonomous,
        running,
        cancelled,
        ...(error ? { error } : {}),
      },
    },
  });
}
export function rejectPiPrompt(
  session: Session,
  owned: Session['pendingTurn'],
  error: unknown,
  makeError: (message: string) => Error,
): void {
  if (!owned || session.pendingTurn !== owned) return;
  const detail = error instanceof Error ? error.message : String(error);
  const busy = /streaming|already.*(?:running|processing)|发送失败：/i.test(detail);
  const value = state(session);
  session.pendingTurn = null;
  if (busy && value.run && !value.run.userStarted && !value.run.autonomous) {
    value.run.autonomous = true;
    lifecycle(session, value.run, true);
  }
  owned.reject(makeError(busy ? '发送失败：Agent 正在工作，消息未发送，请稍后重试。' : detail));
  if (!value.run) {
    session.inAgentLoop = false;
    session.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { running: false, queueDepth: 0 } },
    });
  }
}

export async function cancelPiRun(session: Session) {
  const run = state(session).run;
  const turn = session.pendingTurn;
  // Cancellation is scoped to the run captured before RPC I/O.
  await session.proc.request({ type: 'clear_queue' });
  if (state(session).run === run && session.pendingTurn === turn) await session.proc.abort();
}
export function piRunBusy(session: Session) {
  const value = state(session);
  return !!session.pendingTurn || !!value.run || value.settling > 0;
}
export function piLiveUpdate(session: Session, update: Record<string, any>) {
  const run = state(session).run;
  return run ? { ...update, _meta: { ...update._meta, 'pi-workbench-live': run.id } } : update;
}
export function piMessageId(session: Session) {
  return state(session).messageId;
}
export function handlePiRunEvent(session: Session, event: Record<string, any>): boolean {
  const value = state(session);
  if (event.type === 'agent_start') {
    if (!value.run) {
      const run = { id: randomUUID(), autonomous: !session.pendingTurn };
      value.run = run;
      session.inAgentLoop = true;
      // Autonomous work must not inherit a cancelled/error state from an old prompt.
      session.modelError = undefined;
      if (run.autonomous) session.cancelRequested = false;
      lifecycle(session, run, true);
    }
    return true;
  }
  // agent_end is NOT idle: retries and follow-ups can still run.
  if (event.type === 'agent_end') return true;
  if (event.type === 'message_start') {
    // A custom starter can win the final prompt submission window. Reject the
    // reserved user slot; never queue it into the extension's run.
    if (
      event.message?.role === 'custom' &&
      value.run &&
      !value.run.autonomous &&
      !value.run.userStarted &&
      session.pendingTurn
    ) {
      value.run.autonomous = true;
      const rejected = session.pendingTurn;
      session.pendingTurn = null;
      rejected.reject(new Error('发送失败：Agent 正在工作，消息未发送，请稍后重试。'));
      lifecycle(session, value.run, true);
    }

    if (event.message?.role === 'user' && value.run && !value.run.autonomous)
      value.run.userStarted = true;
    if (event.message?.role === 'assistant') value.messageId = randomUUID();
  }
  if (
    event.type === 'message_end' &&
    event.message?.role === 'custom' &&
    event.message.display === true
  ) {
    const content = event.message.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : '';
    if (text)
      session.emit({
        sessionUpdate: 'agent_message_chunk',
        messageId: randomUUID(),
        content: { type: 'text', text },
        _meta: { 'pi-workbench-notice': true },
      });
  }
  return false;
}
export async function settlePiRun(session: Session, internalError: (message: string) => unknown) {
  const value = state(session);
  const run = value.run;
  const turn = run?.autonomous ? null : session.pendingTurn;
  const cancelled = session.cancelRequested;
  const error = session.modelError;
  // Detach synchronously. A new agent_start may arrive while get_session_stats
  // is outstanding, and belongs to a different run and cancellation scope.
  value.run = undefined;
  if (turn) session.pendingTurn = null;
  session.inAgentLoop = false;
  value.settling++;
  if (run) lifecycle(session, run, false, error, cancelled);
  try {
    await session.publishContextUsage();
    if (error && !cancelled) turn?.reject(internalError(error));
    else turn?.resolve(cancelled ? 'cancelled' : 'end_turn');
  } finally {
    value.settling--;
    if (!piRunBusy(session)) {
      const next = session.turnQueue.shift();
      if (next) session.startTurn(next);
      else
        session.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: 0, running: false } },
        });
    }
  }
}
