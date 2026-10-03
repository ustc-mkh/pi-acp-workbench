// Intentionally plain NDJSON: tests the wire protocol independently of the client's SDK.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const update = update => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update } }) + '\n');
let pending, permission;
createInterface({ input: process.stdin }).on('line', async line => {
  const r = JSON.parse(line);
  if (!r.method) { if (r.id === 'permission-1') { permission = r.result; reply(pending, { stopReason: permission.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' }); } return; }
  if (r.method === 'initialize') {
    if (mode === 'hang') return;
    reply(r.id, { protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: { loadSession: mode !== 'no-load' }, agentInfo: { name: 'mock' }, authMethods: [] });
  } else if (r.method === 'session/new') reply(r.id, { sessionId: 'test-session' });
  else if (r.method === 'session/load') {
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'previous' } }); reply(r.id, {});
  } else if (r.method === 'session/prompt') {
    pending = r.id;
    const text = r.params.prompt[0].text;
    if (text === 'crash') process.exit(7);
    if (text === 'wait') return;
    if (text === 'permission') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'test-session', toolCall: { toolCallId: 'write', title: 'Edit file', status: 'pending' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } }) + '\n'); return;
    }
    // Deliberately split a UTF-8 character and one JSON frame across OS writes.
    const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '数学 $x' } } } }) + '\n');
    const cut = frame.indexOf(Buffer.from('数')) + 1;
    process.stdout.write(frame.subarray(0, cut));
    setTimeout(() => {
      process.stdout.write(frame.subarray(cut));
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '^2$' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', status: 'completed' });
      reply(r.id, { stopReason: 'end_turn' });
    }, 5);
  } else if (r.method === 'session/cancel') reply(pending, { stopReason: 'cancelled' });
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
});
