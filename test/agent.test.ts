import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { AgentProcess } from './support/acp-client';
import type * as acp from '@agentclientprotocol/sdk';
const agents: AgentProcess[] = [];
afterEach(() => {
  agents.splice(0).forEach((a) => a.dispose());
});
function make(
  mode = '',
  permission?: (r: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>,
) {
  const updates: acp.SessionNotification[] = [];
  const closed: string[] = [];
  const agent = new AgentProcess({
    command: process.execPath,
    args: [resolve('test/mock-agent.mjs'), mode],
    cwd: process.cwd(),
    update: (u) => updates.push(u),
    permission: permission || (async () => ({ outcome: { outcome: 'cancelled' } })),
    log: () => {},
    closed: (e) => closed.push(e),
    requestTimeoutMs: mode === 'hang' ? 100 : 3000,
  });
  agents.push(agent);
  return { agent, updates, closed };
}
describe('ACP stdio integration', () => {
  it('negotiates v1, creates a session and streams fragmented UTF-8 safely', async () => {
    const { agent, updates } = make();
    expect((await agent.initialize()).protocolVersion).toBe(1);
    const session = await agent.createSession();
    expect(await agent.prompt(session.sessionId, [{ type: 'text', text: 'hello' }])).toEqual({
      stopReason: 'end_turn',
    });
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
    ]);
    expect(updates[0].update).toMatchObject({ content: { text: '数学 $x' } });
  });
  it('loads a previous session with streamed history', async () => {
    const { agent, updates } = make();
    await agent.initialize();
    await agent.createSession('test-session');
    expect(updates[0].update.sessionUpdate).toBe('user_message_chunk');
  });
  it('does not request unsupported loadSession', async () => {
    const { agent } = make('no-load');
    await agent.initialize();
    await expect(agent.createSession('old')).rejects.toThrow('session/load');
  });
  it('round-trips the exact advertised permission option', async () => {
    const { agent } = make('', async (r) => {
      expect(r.options[0].optionId).toBe('yes');
      return { outcome: { outcome: 'selected', optionId: 'yes' } };
    });
    await agent.initialize();
    await agent.createSession();
    expect(await agent.prompt('test-session', [{ type: 'text', text: 'permission' }])).toEqual({
      stopReason: 'end_turn',
    });
  });
  it('allows a cancelled permission response', async () => {
    const { agent } = make();
    await agent.initialize();
    await agent.createSession();
    expect(await agent.prompt('test-session', [{ type: 'text', text: 'permission' }])).toEqual({
      stopReason: 'cancelled',
    });
  });
  it('cancels an active prompt and waits for the final ACP response', async () => {
    const { agent } = make();
    await agent.initialize();
    await agent.createSession();
    const turn = agent.prompt('test-session', [{ type: 'text', text: 'wait' }]);
    await agent.cancel('test-session');
    expect(await turn).toEqual({ stopReason: 'cancelled' });
  });
  it('rejects unsupported protocol versions', async () => {
    const { agent } = make('v2');
    await expect(agent.initialize()).rejects.toThrow('协议版本');
  });
  it('enforces a hard startup deadline even if the peer ignores cancellation', async () => {
    const { agent } = make('hang');
    await expect(agent.initialize()).rejects.toThrow('超过');
  });
  it('rejects pending prompts when the child crashes', async () => {
    const { agent } = make();
    await agent.initialize();
    await agent.createSession();
    await expect(agent.prompt('test-session', [{ type: 'text', text: 'crash' }])).rejects.toThrow();
  });
});
