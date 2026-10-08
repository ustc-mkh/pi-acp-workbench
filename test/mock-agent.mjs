// Intentionally plain NDJSON: tests the wire protocol independently of the client's SDK.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const native = mode?.startsWith('context-native');
const nativeFile = process.env.PI_TEST_AUDIT + '.native.json';
const nativeDb = () => {
  try {
    return JSON.parse(readFileSync(nativeFile, 'utf8'));
  } catch {
    return {};
  }
};
let points = [],
  assistantTime;
const persistNative = () => {
  if (!native) return;
  const db = nativeDb();
  db[sessionId] = { points, configOptions };
  writeFileSync(nativeFile, JSON.stringify(db));
};
const addPoint = (role, text) => {
  const entryId = 'native-' + points.length,
    timestamp = Date.now() + points.length;
  points.push({
    entryId,
    hash: createHash('sha256')
      .update(JSON.stringify(points) + text)
      .digest('hex'),
    key: role + ':' + createHash('sha256').update(text).digest('hex'),
    role,
    timestamp,
    safe: true,
    configs: structuredClone(configOptions),
  });
  return timestamp;
};
let sessionId = mode?.startsWith('context') ? randomUUID() : 'test-session';
let configOptions = [
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
const modes = {
  currentModeId: 'low',
  availableModes: [
    { id: 'low', name: 'Thinking: low' },
    { id: 'high', name: 'Thinking: high' },
  ],
};
if (mode === 'context-dependent') configOptions[1].options = [{ value: 'low', name: 'Low' }];
if (mode === 'context-codex-options')
  configOptions.push(
    {
      id: 'fast-mode',
      name: 'Fast mode',
      type: 'select',
      currentValue: 'on',
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' },
      ],
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      type: 'select',
      currentValue: 'plan',
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'default', name: 'Default' },
      ],
    },
  );
if (mode === 'context-legacy') configOptions = configOptions.slice(0, 1);
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const update = (update) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) +
      '\n',
  );
let pending, permission;
createInterface({ input: process.stdin }).on('line', async (line) => {
  const r = JSON.parse(line);
  if (process.env.PI_TEST_AUDIT)
    appendFileSync(process.env.PI_TEST_AUDIT, JSON.stringify(r) + '\n');
  if (!r.method) {
    if (r.id === 'permission-1') {
      permission = r.result;
      reply(pending, {
        stopReason: permission.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn',
      });
    }
    return;
  }
  if (r.method === 'initialize') {
    if (mode === 'hang') return;
    reply(r.id, {
      protocolVersion: mode === 'v2' ? 2 : 1,
      agentCapabilities: {
        loadSession: mode !== 'no-load',
        promptCapabilities: { image: mode === 'context-images' || native },
        ...(native
          ? { _meta: { 'pi-workbench': { version: 1, inspect: true, nativeFork: true } } }
          : {}),
      },
      agentInfo: { name: 'mock' },
      authMethods: [],
    });
  } else if (r.method === 'session/new') {
    if (mode?.startsWith('context-missing')) {
      sessionId = randomUUID();
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'status', description: 'Session status' }],
      });
    }
    persistNative();
    reply(r.id, {
      sessionId,
      ...(mode?.startsWith('context')
        ? {
            configOptions,
            ...(['context-dependent', 'context-legacy'].includes(mode) ? { modes } : {}),
          }
        : {}),
    });
  } else if (r.method === 'session/set_config_option') {
    if (mode === 'context-config-fail') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: r.id,
          error: { code: -32603, message: 'config rejected' },
        }) + '\n',
      );
      return;
    }
    configOptions.find((c) => c.id === r.params.configId).currentValue = r.params.value;
    if (mode === 'context-dependent' && r.params.configId === 'model') {
      configOptions[1].options = [
        { value: 'low', name: 'Low' },
        ...(r.params.value === 'other' ? [{ value: 'high', name: 'High' }] : []),
      ];
      configOptions[1].currentValue = 'low';
    }
    persistNative();
    reply(r.id, { configOptions });
  } else if (r.method === 'session/set_mode') {
    modes.currentModeId = r.params.modeId;
    reply(r.id, {});
  } else if (r.method === 'session/load') {
    if (mode?.startsWith('context-missing') || mode === 'context-load-fail') {
      const native = r.params.sessionId;
      const error =
        mode === 'context-missing-claude'
          ? { code: -32002, message: `Resource not found: ${native}`, data: { uri: native } }
          : {
              code: -32603,
              message: 'Internal error',
              data: {
                details:
                  mode === 'context-missing-codex'
                    ? `no rollout found for thread id ${native}`
                    : 'permission denied',
              },
            };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, error }) + '\n');
      return;
    }
    sessionId = r.params.sessionId;
    if (native) {
      const data = nativeDb()[sessionId];
      if (!data) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: r.id,
            error: { code: -32603, message: 'missing native mock' },
          }) + '\n',
        );
        return;
      }
      points = data.points;
      configOptions = data.configOptions;
      reply(r.id, { configOptions });
      return;
    }
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'previous' } });
    reply(r.id, mode === 'context-codex-options' ? { configOptions } : {});
  } else if (native && r.method === '_pi_workbench/cancel_fork') {
    reply(r.id, {});
  } else if (r.method === '_pi_workbench/inspect' && native) {
    reply(r.id, {
      records: [],
      contextWindow: 272000,
      forkPoints: points.map(({ configs, ...point }) => point),
    });
  } else if (r.method === '_pi_workbench/fork' && native) {
    const index = points.findIndex(
      (p) => p.entryId === r.params.entryId && p.hash === r.params.hash,
    );
    if (index < 0 || mode === 'context-native-fail') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: r.id,
          error: { code: -32603, message: 'native fork rejected' },
        }) + '\n',
      );
      return;
    }
    const id = randomUUID(),
      db = nativeDb();
    db[id] = { points: points.slice(0, index + 1), configOptions: points[index].configs };
    writeFileSync(nativeFile, JSON.stringify(db));
    reply(r.id, { sessionId: id });
  } else if (r.method === 'session/prompt') {
    pending = r.id;
    const text = mode?.startsWith('context')
      ? r.params.prompt.filter((b) => b.type === 'text').at(-1)?.text || ''
      : r.params.prompt[0].text;
    if (native) {
      addPoint('user', text);
      persistNative();
    }
    if (mode === 'context-diff' && text.startsWith('edit-workspace')) {
      writeFileSync('change.txt', 'intermediate\n');
      writeFileSync('change.txt', 'agent final\n');
      writeFileSync('created.txt', 'new file\n');
      if (text === 'edit-workspace-crash') process.exit(7);
      if (text === 'edit-workspace-wait') return;
    }
    if (mode === 'context-live') {
      update({ sessionUpdate: 'usage_update', used: 1234, size: 200000 });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'term',
        title: 'bash',
        _meta: { terminal_info: { terminal_id: 'term', cwd: process.cwd() } },
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term',
        _meta: { terminal_output: { terminal_id: 'term', data: 'first\n' } },
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'term',
        _meta: { terminal_output: { terminal_id: 'term', data: 'second' } },
      });
    }
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
    if (native) assistantTime = addPoint('assistant', '数学 $x^2$');
    // Deliberately split a UTF-8 character and one JSON frame across OS writes.
    const frame = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            ...(native ? { messageId: String(assistantTime) } : {}),
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
        ...(native ? { messageId: String(assistantTime) } : {}),
        content: { type: 'text', text: '^2$' },
      });
      update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', status: 'completed' });
      persistNative();
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
