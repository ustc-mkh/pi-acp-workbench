import { expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { enhancePiAgent } from '../src/pi-enhancements';
import type { PiProcess, PiSession } from '../src/pi-rpc-types';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((pass) => {
    resolve = pass;
  });
  return { promise, resolve };
};

it.each(['restore', 'refresh', 'base-restore'] as const)(
  'preserves cancellation through %s and allows a following turn',
  async (phase) => {
    const gate = deferred<{}>(),
      entered = deferred<void>(),
      forwarded = vi.fn();
    const session: PiSession = {
      sessionId: 'one',
      cwd: '/work',
      cancelRequested: false,
      proc: {
        getState: async () => {
          if (phase === 'refresh') {
            entered.resolve();
            await gate.promise;
          }
          return {};
        },
        request: async () => ({ success: true, data: { commands: [] } }),
      } as unknown as PiProcess,
      publishContextUsage: async () => {},
      wasCancelRequested() {
        return this.cancelRequested;
      },
    };
    class Base {
      sessions = new Map<string, PiSession>();
      restores = 0;
      async restoreSession() {
        this.restores++;
        if (
          (phase === 'restore' && this.restores === 1) ||
          (phase === 'base-restore' && this.restores === 2)
        ) {
          entered.resolve();
          await gate.promise;
        }
        this.sessions.set('one', session);
        return session;
      }
      async prompt(
        _params: acp.PromptRequest,
        cancelled = () => false,
      ): Promise<acp.PromptResponse> {
        await this.restoreSession();
        if (cancelled()) return { stopReason: 'cancelled' };
        forwarded();
        return { stopReason: 'end_turn' };
      }
      async cancel() {
        const active = this.sessions.get('one');
        if (active) active.cancelRequested = true;
      }
      dispose() {}
    }
    const Enhanced = enhancePiAgent(Base, undefined);
    const agent = new Enhanced();
    const params: acp.PromptRequest = {
      sessionId: 'one',
      prompt: [{ type: 'text', text: 'task' }],
    };
    const running = agent.prompt(params);
    await entered.promise;
    await agent.cancel({ sessionId: 'one' });
    gate.resolve({});
    expect((await running).stopReason).toBe('cancelled');
    expect(forwarded).not.toHaveBeenCalled();
    expect((await agent.prompt(params)).stopReason).toBe('end_turn');
    expect(forwarded).toHaveBeenCalledOnce();
  },
);
