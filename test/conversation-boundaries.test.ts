import { describe, expect, it, vi } from 'vitest';
import { ActiveConversation } from '../src/active-conversation';
import { ConversationLifecycle } from '../src/conversation-lifecycle';
import { parseUiMessage } from '../src/ui-message-schema';
import type { Agent } from '../src/remote-agent';

it('resets every active conversation field and invalidates outstanding operations', () => {
  const active = new ActiveConversation();
  const contextAbort = new AbortController();
  const dispose = vi.fn();
  active.replace({
    cwd: '/old',
    contextWindow: 100,
    conversationId: 'old',
    agent: { dispose } as unknown as Agent,
    contextAbort,
    generation: 8,
    state: { ...active.state, sessionId: 'old' },
  });
  active.reset({ harness: 'codex', attachments: [] });
  expect(contextAbort.signal.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(active).toMatchObject({
    cwd: '',
    generation: 9,
    agent: undefined,
    contextWindow: undefined,
    conversationId: undefined,
    contextAbort: undefined,
  });
  expect(active.state).toMatchObject({ harness: 'codex', status: 'disconnected' });
  expect(active.state.sessionId).toBeUndefined();
});

describe('lifecycle request arbitration', () => {
  const ready = { status: 'ready' as const, sessionId: 'one', harness: 'pi' as const };
  const busy = { ...ready, status: 'busy' as const };
  const gated = { gated: true };
  const navigation = { gated: true, navigation: true };
  it('gates before awaits while cancellation and permission remain available', () => {
    const lifecycle = new ConversationLifecycle();
    const send = lifecycle.acquire({ type: 'send', text: 'hi' }, gated, ready);
    expect(send).toBeTruthy();
    expect(lifecycle.acquire({ type: 'new' }, navigation, ready)).toBe(false);
    expect(lifecycle.acquire({ type: 'cancel' }, {}, busy)).toBeUndefined();
    expect(lifecycle.acquire({ type: 'permission', id: 'p' }, {}, busy)).toBeUndefined();
    expect(lifecycle.allowed(gated, busy)).toBe(false);
    lifecycle.dispose();
    expect(lifecycle.acquire({ type: 'cancel' }, {}, busy)).toBe(false);
  });
  it('restores a pending turn gate after failed navigation but never after a generation change', () => {
    const lifecycle = new ConversationLifecycle();
    const send = lifecycle.acquire({ type: 'send', text: 'hi' }, gated, ready);
    expect(lifecycle.acquire({ type: 'resume', id: 'one' }, navigation, busy)).toBe(false);
    const next = lifecycle.acquire({ type: 'resume', id: 'two' }, navigation, busy);
    if (!send || !next) throw new Error('expected gates');
    lifecycle.release(next, true);
    expect(lifecycle.acquire({ type: 'config', id: 'model', value: 'm' }, gated, ready)).toBe(
      false,
    );
    lifecycle.release(send, false);
    expect(lifecycle.acquire({ type: 'new' }, navigation, ready)).toBeTruthy();
  });
  it('keeps cancellation of a preparing turn across failed navigation', () => {
    const lifecycle = new ConversationLifecycle();
    const send = lifecycle.acquire({ type: 'send', text: 'hi' }, gated, ready);
    lifecycle.beginTurn();
    const next = lifecycle.acquire({ type: 'new' }, navigation, busy);
    if (!send || !next) throw new Error('expected gates');
    lifecycle.transition(true);
    lifecycle.cancel();
    expect(lifecycle.cancelled).toBe(true);
    lifecycle.transition(false);
    lifecycle.release(next, true);
    expect(lifecycle.cancelled).toBe(true);
    lifecycle.finishTurn();
    lifecycle.release(send, true);
    expect(lifecycle.cancelled).toBe(false);
  });
  it('does not restore a finished turn or transfer its cancellation to another generation', () => {
    const lifecycle = new ConversationLifecycle();
    const send = lifecycle.acquire({ type: 'send', text: 'hi' }, gated, ready);
    lifecycle.beginTurn();
    lifecycle.prompt(true);
    const next = lifecycle.acquire({ type: 'new' }, navigation, busy);
    if (!send || !next) throw new Error('expected gates');
    lifecycle.transition(true);
    lifecycle.finishTurn();
    lifecycle.transition(false);
    lifecycle.release(next, true);
    expect(lifecycle.prompting).toBe(false);
    const another = lifecycle.acquire({ type: 'new' }, navigation, busy);
    if (!another) throw new Error('expected gate');
    lifecycle.cancel();
    lifecycle.release(another, false);
    expect(lifecycle.cancelled).toBe(false);
    const fresh = new ConversationLifecycle();
    fresh.acquire({ type: 'send', text: 'hi' }, gated, ready);
    fresh.beginTurn();
    const moved = fresh.acquire({ type: 'new' }, navigation, busy);
    if (!moved) throw new Error('expected gate');
    fresh.transition(true);
    fresh.cancel();
    expect(fresh.cancelled).toBe(true);
    fresh.transition(false);
    fresh.release(moved, false);
    expect(fresh.cancelled).toBe(false);
  });
  it('never resurrects a completed old send after navigation', () => {
    const lifecycle = new ConversationLifecycle();
    const send = lifecycle.acquire({ type: 'send', text: 'hi' }, gated, ready);
    const next = lifecycle.acquire({ type: 'new' }, navigation, busy);
    if (!send || !next) throw new Error('expected gates');
    lifecycle.release(send, true);
    lifecycle.release(next, true);
    expect(
      lifecycle.acquire({ type: 'config', id: 'model', value: 'm' }, gated, ready),
    ).toBeTruthy();
  });
});

it('validates messages at the dispatch boundary, including prototypes and bounded payloads', () => {
  for (const value of [null, [], {}, { type: 'constructor' }, { type: '__proto__' }])
    expect(parseUiMessage(value)).toBeUndefined();
  for (const value of [
    { type: 'config', id: 1, value: 'm' },
    { type: 'switchHarness', harness: 'unknown' },
    { type: 'setVisibleModels', harness: 'pi', models: [1] },
    { type: 'setVisibleModels', harness: 'pi', models: new Array(2) },
    { type: 'attachImages', images: new Array(2) },
    { type: 'send', text: 'x'.repeat(500001) },
    { type: 'diff', id: 'one', index: -2 },
    { type: 'setPrice', model: 'm', price: { input: NaN } },
  ])
    expect(() => parseUiMessage(value)).toThrow('消息参数无效');
  expect(parseUiMessage({ type: 'diff', id: 'one', index: -1 })).toBeTruthy();
  expect(parseUiMessage({ type: 'send', text: 'hi' })).toEqual({ type: 'send', text: 'hi' });
});
