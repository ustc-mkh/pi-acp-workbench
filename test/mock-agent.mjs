// Intentionally plain NDJSON: tests the wire protocol independently of the client's SDK.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
let sessionId = 'test-session';
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'other', name: 'Other' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'low',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
];
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const update = (update) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) +
      '\n',
  );
let pending;
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (process.env.PI_TEST_AUDIT)
    appendFileSync(process.env.PI_TEST_AUDIT, JSON.stringify(r) + '\n');
  if (!r.method) {
    if (r.id === 'permission-1') {
      reply(pending, {
        stopReason: r.result.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn',
      });
    }
    return;
  }
  if (r.method === 'initialize') {
    if (mode === 'hang') return;
    reply(r.id, {
      protocolVersion: mode === 'v2' ? 2 : 1,
      agentCapabilities: { loadSession: mode !== 'no-load', promptCapabilities: { image: false } },
      agentInfo: { name: 'mock' },
      authMethods: [],
    });
  } else if (r.method === 'session/new') {
    reply(r.id, { sessionId });
  } else if (r.method === 'session/load') {
    sessionId = r.params.sessionId;
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'previous' } });
    reply(r.id, {});
  } else if (r.method === 'session/set_config_option') {
    configOptions.find((option) => option.id === r.params.configId).currentValue = r.params.value;
    reply(r.id, { configOptions });
  } else if (r.method === 'session/prompt') {
    pending = r.id;
    const text = r.params.prompt[0].text;
    if (text === 'crash') process.exit(7);
    if (text === 'wait') return;
    if (text === 'permission') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'permission-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'write', title: 'Edit file', status: 'pending' },
            options: [
              { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'no', kind: 'reject_once', name: 'Reject' },
            ],
          },
        }) + '\n',
      );
      return;
    }
    // Deliberately split a UTF-8 character and one JSON frame across OS writes.
    const frame = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '数学 $x' },
          },
        },
      }) + '\n',
    );
    const cut = frame.indexOf(Buffer.from('数')) + 1;
    process.stdout.write(frame.subarray(0, cut));
    setTimeout(() => {
      process.stdout.write(frame.subarray(cut));
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '^2$' },
      });
      update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', status: 'completed' });
      reply(r.id, { stopReason: 'end_turn' });
    }, 5);
  } else if (r.method === 'session/cancel') reply(pending, { stopReason: 'cancelled' });
  else
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: r.id,
        error: { code: -32601, message: 'Unknown method' },
      }) + '\n',
    );
});
