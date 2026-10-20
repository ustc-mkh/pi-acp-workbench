#!/usr/bin/env node
// Minimal ACP peer for the new workbenchd contract tests.
// Plain NDJSON JSON-RPC on stdio — intentionally independent of any SDK, so the
// same binary exercises the wire/daemon contract from either implementation.
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { NativeForkFixture } from './helpers/native-fork-fixture.mjs';

const trace = (record) => {
  if (process.env.WORKBENCH_CONTRACT_TRACE)
    appendFileSync(process.env.WORKBENCH_CONTRACT_TRACE, JSON.stringify(record) + '\n');
};
trace({ method: 'boot', pid: process.pid });

const nativeFixture = process.env.WORKBENCH_CONTRACT_NATIVE_STATE
  ? new NativeForkFixture(process.env.WORKBENCH_CONTRACT_NATIVE_STATE)
  : undefined;
let nativePrompt;
let waitingFork;
let sessionId;
let pending; // pending session/prompt request id
let permission; // pending permission request id
const permissionBatch = new Set();
let batchCancelled = false;
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
];
const modelState = process.env.WORKBENCH_CONTRACT_MODEL_STATE;
if (modelState && existsSync(modelState))
  configOptions[0].currentValue = readFileSync(modelState, 'utf8');
const modes = {
  currentModeId: 'low',
  availableModes: [
    { id: 'low', name: 'Thinking: low' },
    { id: 'high', name: 'Thinking: high' },
  ],
};

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => {
  if (id === nativePrompt) nativePrompt = undefined;
  send({ jsonrpc: '2.0', id, result });
};
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const update = (update) => {
  if (
    nativeFixture &&
    nativePrompt !== undefined &&
    update.sessionUpdate === 'agent_message_chunk' &&
    update.content?.type === 'text'
  )
    nativeFixture.record(
      sessionId,
      'assistant',
      update.content.text,
      configOptions[0].currentValue,
      modes.currentModeId,
      update.messageId,
    );
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  // Response to our outgoing permission request.
  if (!r.method) {
    trace({
      method: 'agent-response',
      id: r.id,
      outcome: r.result?.outcome?.outcome,
      action: r.result?.action,
    });
    if (permissionBatch.delete(r.id) && pending) {
      batchCancelled ||= r.result?.outcome?.outcome === 'cancelled';
      if (permissionBatch.size === 0) {
        reply(pending, { stopReason: batchCancelled ? 'cancelled' : 'end_turn' });
        pending = undefined;
      }
    } else if (r.id === 'perm-1' && pending) {
      const outcome = r.result?.outcome;
      reply(pending, { stopReason: outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' });
      pending = undefined;
    } else if (r.id === 'elicitation-1' && pending) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(r.result) },
      });
      reply(pending, { stopReason: r.result?.action === 'cancel' ? 'cancelled' : 'end_turn' });
      pending = undefined;
    }
    return;
  }
  if (r.method === 'initialize') {
    reply(r.id, {
      protocolVersion: 1,
      clientCapabilities: {},
      agentInfo: { name: 'contract-agent', title: 'Contract Agent', version: '1' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        _meta: {
          'pi-workbench': {
            version: 1,
            autonomousRuns:
              process.env.WORKBENCH_CONTRACT_AUTONOMOUS === '1'
                ? true
                : process.env.WORKBENCH_CONTRACT_AUTONOMOUS === 'unknown'
                  ? undefined
                  : false,
            inspect: true,
            nativeFork: true,
            title: !!process.env.WORKBENCH_CONTRACT_MANAGEMENT,
            models: !!process.env.WORKBENCH_CONTRACT_MANAGEMENT,
          },
        },
      },
      authMethods: [],
    });
  } else if (r.method === 'session/new') {
    sessionId = randomUUID();
    nativeFixture?.create(sessionId, configOptions[0].currentValue, modes.currentModeId);
    reply(r.id, { sessionId, configOptions, modes });
  } else if (r.method === 'session/load') {
    if (nativeFixture) {
      try {
        const state = nativeFixture.read(r.params.sessionId);
        configOptions[0].currentValue = state.model;
        modes.currentModeId = state.mode;
      } catch {
        fail(r.id, 'fixture native session unavailable');
        return;
      }
    }
    sessionId = r.params.sessionId;
    trace({ method: r.method, sessionId });
    const count = Math.min(5000, Number(process.env.WORKBENCH_CONTRACT_REPLAY_UPDATES ?? 0));
    for (let i = 0; i < count; i++) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `replayed ${i}` },
      });
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: `old user ${i}` },
      });
      update({ sessionUpdate: 'plan', entries: [{ content: 'old plan', status: 'pending' }] });
    }
    if (process.env.WORKBENCH_CONTRACT_REPLAY_INTERACTION === '1') {
      send({
        jsonrpc: '2.0',
        id: 'replay-permission',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'old-tool', title: 'Old permission' },
          options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
        },
      });
      send({
        jsonrpc: '2.0',
        id: 'replay-form',
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: 'Old form',
          requestedSchema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      });
    }
    if (process.env.WORKBENCH_CONTRACT_WRONG_LOAD_SESSION === '1') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'foreign-session',
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'high' },
        },
      });
    }
    const catalogue = process.env.WORKBENCH_CONTRACT_LOAD_CATALOGUE;
    if (catalogue === 'empty') {
      update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
      reply(r.id, { configOptions: [], modes: { currentModeId: 'low', availableModes: [] } });
    } else reply(r.id, catalogue === 'omit' ? {} : { configOptions, modes });
  } else if (r.method === 'session/prompt') {
    const text = r.params.prompt
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    trace({ method: r.method, text });
    nativePrompt = r.id;
    nativeFixture?.record(
      sessionId,
      'user',
      text,
      configOptions[0].currentValue,
      modes.currentModeId,
    );
    if (text.startsWith('workspace-write') && process.env.WORKBENCH_CONTRACT_WORKSPACE_FILE) {
      const file = process.env.WORKBENCH_CONTRACT_WORKSPACE_FILE;
      const deleted = process.env.WORKBENCH_CONTRACT_WORKSPACE_DELETE;
      const added = process.env.WORKBENCH_CONTRACT_WORKSPACE_ADD;
      execFileSync('/bin/sh', ['-c', 'printf "after\\n" > "$1"', 'workspace-write', file]);
      if (deleted) unlinkSync(deleted);
      if (added) writeFileSync(added, 'added\n');
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'workspace changes applied' },
      });
      if (text === 'workspace-write-crash') process.exit(7);
      if (text === 'workspace-write-wait') {
        pending = r.id;
        return;
      }
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'worker-profile') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `${process.env.WORKBENCH_CONTRACT_PROVIDER}:${process.argv[2]}`,
        },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (/^permissions:(2|32|33)$/.test(text)) {
      pending = r.id;
      permissionBatch.clear();
      batchCancelled = false;
      for (let index = 0; index < Number(text.slice('permissions:'.length)); index++) {
        const id = `batch-${index}`;
        permissionBatch.add(id);
        send({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: id, title: `Bounded permission ${index}` },
            options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
          },
        });
      }
      return;
    }
    if (text === 'permission-over-limit') {
      pending = r.id;
      for (const id of ['perm-1', 'perm-2'])
        send({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: id, title: 'Bounded permission' },
            options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
          },
        });
      return;
    }
    if (text === 'rpc-error-secret') {
      fail(r.id, 'SENSITIVE_PROVIDER_DESCRIPTION');
      return;
    }
    if (text === 'wrong-session') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'foreign-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'must-not-enter-history' },
          },
        },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'catalogue-update' || text === 'catalogue-clear') {
      const clear = text === 'catalogue-clear';
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: clear
          ? []
          : [{ name: 'review', description: 'Review code', input: { hint: 'PATH' } }],
      });
      update({ sessionUpdate: 'config_option_update', configOptions: clear ? [] : configOptions });
      if (!clear) {
        modes.currentModeId = 'high';
        update({ sessionUpdate: 'current_mode_update', currentModeId: 'high' });
      }
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'check-bot-env') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text:
            process.env.REWRITE_TEST_BOT_TOKEN === undefined ? 'bot-env-hidden' : 'bot-env-visible',
        },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'usage-report' || text === 'usage-complete') {
      update({ sessionUpdate: 'usage_update', used: 500, size: 200000 });
      reply(r.id, {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 50,
          ...(text === 'usage-complete' ? { cachedWriteTokens: 5 } : {}),
          totalTokens: 170,
        },
      });
      return;
    }
    if (text === 'plan-report') {
      update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'done', status: 'completed', priority: 'medium' },
          { content: 'active', status: 'in_progress', priority: 'medium' },
          { content: 'pending', status: 'pending', priority: 'medium' },
        ],
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'wait') {
      pending = r.id;
      return;
    }
    if (text === 'crash') process.exit(7);
    if (text.startsWith('elicitation')) {
      pending = r.id;
      send({
        jsonrpc: '2.0',
        id: 'elicitation-1',
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: '选择一个值',
          requestedSchema: {
            type: 'object',
            required: text === 'elicitation-multi' ? ['question_0', 'question_1'] : ['question_0'],
            properties:
              text === 'elicitation-text'
                ? { question_0: { type: 'string' } }
                : text === 'elicitation-multi'
                  ? {
                      question_0: {
                        type: 'array',
                        items: { anyOf: [{ const: 'a:b' }, { const: '其它' }] },
                      },
                      question_1: { type: 'string' },
                    }
                  : {
                      question_0: {
                        type: 'string',
                        oneOf: [
                          { const: 'a:b', title: '含冒号' },
                          { const: '其它', title: '其它' },
                        ],
                      },
                    },
          },
        },
      });
      return;
    }
    if (text === 'permission') {
      if (process.env.WORKBENCH_CONTRACT_WRITE_ON_PERMISSION)
        execFileSync('/bin/sh', [
          '-c',
          'printf "after\\n" > "$1"',
          'workspace-write',
          process.env.WORKBENCH_CONTRACT_WRITE_ON_PERMISSION,
        ]);
      pending = r.id;
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'write-1', title: 'Edit file', status: 'pending' },
          options: [
            { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'no', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      return;
    }
    if (['image-output', 'image-malformed', 'history-gated-image'].includes(text)) {
      const messageId = randomUUID();
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: {
          type: 'image',
          mimeType: 'image/png',
          uri: 'https://example.invalid/never-fetch',
          data:
            text !== 'image-malformed'
              ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
              : 'invalid-base64',
        },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: 'image caption' },
      });
      const historyGate = process.env.WORKBENCH_CONTRACT_CONFIG_GATE;
      if (text === 'history-gated-image' && historyGate) {
        writeFileSync(`${historyGate}.history-started`, 'started');
        let moreSent = false;
        const waiting = setInterval(() => {
          if (!moreSent && existsSync(`${historyGate}.history-more`)) {
            moreSent = true;
            update({
              sessionUpdate: 'agent_message_chunk',
              messageId,
              content: { type: 'text', text: ' preview tail update' },
            });
          }
          if (existsSync(`${historyGate}.history-release`)) {
            clearInterval(waiting);
            reply(r.id, { stopReason: 'end_turn' });
          }
        }, 5);
        return;
      }
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'tool-metadata') {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool:edit',
        title: 'Edit file',
        kind: 'edit',
        name: 'apply_patch',
        status: 'in_progress',
        content: [{ type: 'diff', path: '/display/only.rs', oldText: 'before', newText: 'after' }],
        locations: [{ path: '/display/only.rs', line: 0 }],
        rawInput: { hidden: 'NOT_IN_DOMAIN' },
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool:edit',
        status: 'completed',
        kind: 'future_kind',
        content: null,
        locations: null,
      });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool:clear',
        title: 'Clear buffers',
        kind: 'read',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'temporary' } }],
        locations: [{ path: '/display/temporary' }],
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool:clear',
        status: 'completed',
        content: [],
        locations: [],
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'tool metadata done' },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'streamed-message') {
      const messageId = randomUUID();
      update({
        sessionUpdate: 'agent_thought_chunk',
        messageId,
        content: { type: 'text', text: 'reasoning' },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: 'hello ' },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: '世界' },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'big') {
      // >512 KiB state: forces fragmented wire responses on the next state read.
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x'.repeat(600 * 1024) },
      });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `echo: ${text}` },
    });
    update({ sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Read', status: 'completed' });
    reply(r.id, { stopReason: 'end_turn' });
  } else if (r.method === 'session/cancel') {
    trace({ method: r.method });
    if (pending) {
      reply(pending, { stopReason: 'cancelled' });
      pending = undefined;
    }
    // Notifications carry no id; nothing to reply.
  } else if (r.method === 'session/set_config_option') {
    trace({ method: r.method, configId: r.params.configId, value: r.params.value });
    const config = configOptions.find((c) => c.id === r.params.configId);
    if (r.params.value === process.env.WORKBENCH_CONTRACT_REJECT_MODEL) {
      fail(r.id, 'fixture rejected setting');
      return;
    }
    if (config) {
      config.currentValue = r.params.value;
      if (modelState) writeFileSync(modelState, config.currentValue);
      nativeFixture?.configure(sessionId, configOptions[0].currentValue, modes.currentModeId);
    }
    const gate = process.env.WORKBENCH_CONTRACT_CONFIG_GATE;
    if (gate) {
      writeFileSync(`${gate}.started`, 'started');
      const waiting = setInterval(() => {
        if (existsSync(`${gate}.release`)) {
          clearInterval(waiting);
          reply(r.id, { configOptions });
        }
      }, 5);
    } else reply(r.id, { configOptions });
  } else if (r.method === 'session/set_mode') {
    modes.currentModeId = r.params.modeId;
    nativeFixture?.configure(sessionId, configOptions[0].currentValue, modes.currentModeId);
    if (process.env.WORKBENCH_CONTRACT_METADATA_NOTIFICATIONS === '1') {
      update({ sessionUpdate: 'current_mode_update', currentModeId: modes.currentModeId });
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review code', input: { hint: 'PATH' } },
        ],
      });
    }
    reply(r.id, {});
  } else if (r.method === '_pi_workbench/models') {
    trace({ method: r.method, params: r.params });
    if (!process.env.WORKBENCH_CONTRACT_MANAGEMENT) {
      fail(r.id, 'not negotiated');
      return;
    }
    if (r.params.setContext)
      process.env.WORKBENCH_CONTRACT_CONTEXT = String(r.params.contextWindow ?? 200000);
    reply(r.id, {
      models: ['default', 'other'].map((model) => ({
        model,
        contextWindow: Number(process.env.WORKBENCH_CONTRACT_CONTEXT ?? 200000),
        price: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.5 },
      })),
    });
  } else if (r.method === '_pi_workbench/title') {
    trace({ method: r.method });
    const finish = () =>
      reply(r.id, {
        title: 'Synthetic short title',
        records: [{ model: 'default', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }],
      });
    if (process.env.WORKBENCH_CONTRACT_TITLE_GATE) {
      const timer = setInterval(() => {
        if (existsSync(process.env.WORKBENCH_CONTRACT_TITLE_GATE)) {
          clearInterval(timer);
          finish();
        }
      }, 10);
    } else finish();
  } else if (r.method === '_pi_workbench/inspect') {
    reply(r.id, {
      records: [],
      contextWindow: 200000,
      forkPoints: [
        ...(nativeFixture
          ? [
              {
                entryId: 'unsafe-intermediate',
                hash: '',
                role: 'assistant',
                key: `assistant:${'a'.repeat(64)}`,
                safe: false,
              },
            ]
          : []),
        ...(nativeFixture?.points(sessionId) ?? []),
      ],
    });
  } else if (r.method === '_pi_workbench/cancel_fork') {
    trace({ method: r.method });
    if (waitingFork) {
      clearInterval(waitingFork.timer);
      fail(waitingFork.id, 'fixture native fork cancelled');
      waitingFork = undefined;
    }
    reply(r.id, {});
  } else if (r.method === '_pi_workbench/fork') {
    trace({ method: r.method, entryId: r.params.entryId });
    try {
      if (!nativeFixture) throw new Error('fixture disabled');
      const forked = nativeFixture.fork(sessionId, r.params.entryId, r.params.hash);
      const gate = process.env.WORKBENCH_CONTRACT_FORK_GATE;
      if (gate) {
        writeFileSync(`${gate}.started`, 'started');
        const timer = setInterval(() => {
          if (existsSync(`${gate}.release`)) {
            clearInterval(timer);
            waitingFork = undefined;
            reply(r.id, { sessionId: forked });
          }
        }, 5);
        waitingFork = { id: r.id, timer };
      } else reply(r.id, { sessionId: forked });
    } catch {
      fail(r.id, 'native fork unavailable or prefix mismatch in contract-agent');
    }
  } else {
    fail(r.id, `unknown method ${r.method}`);
  }
});
