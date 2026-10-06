#!/usr/bin/env node
// Minimal ACP agent for service contract tests (scripts/service-contract.mjs).
// Plain NDJSON JSON-RPC on stdio — intentionally independent of any SDK, so the
// same binary exercises the wire/daemon contract from either implementation.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

let sessionId;
let pending;      // pending session/prompt request id
let permission;   // pending permission request id
const configOptions = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }, { value: 'other', name: 'Other' }] },
];
const modes = { currentModeId: 'low', availableModes: [{ id: 'low', name: 'Thinking: low' }, { id: 'high', name: 'Thinking: high' }] };

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
const update = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

createInterface({ input: process.stdin }).on('line', line => {
  let r;
  try { r = JSON.parse(line); } catch { return; }
  // Response to our outgoing permission request.
  if (!r.method) {
    if (r.id === 'perm-1' && pending) {
      const outcome = r.result?.outcome;
      reply(pending, { stopReason: outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' });
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
        _meta: { 'pi-workbench': { version: 1, inspect: true, nativeFork: true } },
      },
      authMethods: [],
    });
  } else if (r.method === 'session/new') {
    sessionId = randomUUID();
    reply(r.id, { sessionId, configOptions, modes });
  } else if (r.method === 'session/load') {
    sessionId = r.params.sessionId;
    reply(r.id, { configOptions, modes });
  } else if (r.method === 'session/prompt') {
    const text = r.params.prompt.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text === 'wait') { pending = r.id; return; }
    if (text === 'crash') process.exit(7);
    if (text === 'permission') {
      pending = r.id;
      send({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'write-1', title: 'Edit file', status: 'pending' },
        options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow once' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }],
      }});
      return;
    }
    if (text === 'big') {
      // >512 KiB state: forces fragmented wire responses on the next state read.
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(600 * 1024) } });
      reply(r.id, { stopReason: 'end_turn' });
      return;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } });
    update({ sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'Read', status: 'completed' });
    reply(r.id, { stopReason: 'end_turn' });
  } else if (r.method === 'session/cancel') {
    if (pending) { reply(pending, { stopReason: 'cancelled' }); pending = undefined; }
    // Notifications carry no id; nothing to reply.
  } else if (r.method === 'session/set_config_option') {
    const config = configOptions.find(c => c.id === r.params.configId);
    if (config) config.currentValue = r.params.value;
    reply(r.id, { configOptions });
  } else if (r.method === 'session/set_mode') {
    modes.currentModeId = r.params.modeId;
    reply(r.id, {});
  } else if (r.method === '_pi_workbench/inspect') {
    reply(r.id, { records: [], contextWindow: 200000, forkPoints: [] });
  } else if (r.method === '_pi_workbench/cancel_fork') {
    reply(r.id, {});
  } else if (r.method === '_pi_workbench/fork') {
    fail(r.id, 'native fork not supported by contract-agent');
  } else {
    fail(r.id, `unknown method ${r.method}`);
  }
});
