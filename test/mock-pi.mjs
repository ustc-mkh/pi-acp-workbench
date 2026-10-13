#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const sid = randomUUID(),
  file = join(process.cwd(), sid + '.jsonl');
const model = {
  provider: process.env.PI_TEST_FAST_MODE ? 'openai-codex' : 'anthropic',
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: true,
  input: ['text'],
  api: process.env.PI_TEST_FAST_MODE ? 'openai-codex-responses' : 'anthropic-messages',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
let messages = [],
  thinking = 'off',
  contextTokens = 1020;
const fastEntries = [];
let heldStateReply;
let wakeActive = false;
let queuedPrompts = [];
const statsReplies = [];
const control = process.env.PI_TEST_WAKE_CONTROL;
function startWake() {
  wakeActive = true;
  send({ type: 'agent_start' });
  const custom = {
    role: 'custom',
    customType: 'background-completion-batch',
    content: '后台任务已完成',
    display: true,
  };
  send({ type: 'message_start', message: custom });
  send({ type: 'message_end', message: custom });
  if (control && existsSync(control + '.permission')) {
    unlinkSync(control + '.permission');
    send({
      type: 'extension_ui_request',
      id: 'background-confirm',
      method: 'confirm',
      title: 'Background confirmation',
      message: 'Proceed?',
    });
  }
  const message = { role: 'assistant', content: [], timestamp: Date.now() };
  send({ type: 'message_start', message });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: '后台分析' },
  });
  send({
    type: 'tool_execution_start',
    toolCallId: 'wake-tool',
    toolName: 'bash',
    args: { command: 'printf background-output' },
  });
  send({
    type: 'tool_execution_update',
    toolCallId: 'wake-tool',
    partialResult: { content: [{ type: 'text', text: 'background-output' }] },
  });
  send({
    type: 'tool_execution_end',
    toolCallId: 'wake-tool',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'background-output' }] },
    isError: false,
  });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: '自主唤醒回复' },
  });
}
function finishWake() {
  wakeActive = false;
  send({ type: 'agent_end', messages: [] });
  const queued = queuedPrompts.splice(0);
  if (queued.length) for (const cmd of queued) handleCommand({ ...cmd, skipReply: true });
  else send({ type: 'agent_settled' });
}
if (control)
  setInterval(() => {
    if (existsSync(control + '.wake') && !wakeActive) {
      unlinkSync(control + '.wake');
      startWake();
    }
    if (existsSync(control + '.continue') && wakeActive) {
      unlinkSync(control + '.continue');
      send({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '，继续输出' },
      });
    }
    if (existsSync(control + '.finish') && wakeActive) {
      unlinkSync(control + '.finish');
      finishWake();
    }
    if (!existsSync(control + '.stats-hold')) for (const reply of statsReplies.splice(0)) reply();
  }, 10).unref();
writeFileSync(
  file,
  JSON.stringify({
    type: 'session',
    id: sid,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  }) + '\n',
);
if (process.env.PI_TEST_AUDIT)
  appendFileSync(
    process.env.PI_TEST_AUDIT,
    JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\n',
  );
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const append = (e) =>
  appendFileSync(
    file,
    JSON.stringify({ ...e, id: randomUUID(), timestamp: new Date().toISOString() }) + '\n',
  );
function handleCommand(input) {
  const cmd = typeof input === 'string' ? JSON.parse(input) : input;
  if (process.env.PI_TEST_PREFLIGHT_AUDIT && !cmd.skipReply)
    appendFileSync(
      process.env.PI_TEST_PREFLIGHT_AUDIT,
      JSON.stringify({
        type: cmd.type,
        message: cmd.message,
        streamingBehavior: cmd.streamingBehavior,
      }) + '\n',
    );
  const reply = (data) =>
    !cmd.skipReply &&
    send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
  switch (cmd.type) {
    case 'get_state': {
      const data = {
        sessionId: sid,
        sessionFile: file,
        model,
        thinkingLevel: thinking,
        isStreaming: wakeActive,
      };
      if (process.env.PI_TEST_PREFLIGHT_FLAG && existsSync(process.env.PI_TEST_PREFLIGHT_FLAG)) {
        heldStateReply = () => reply(data);
        appendFileSync(
          process.env.PI_TEST_PREFLIGHT_AUDIT,
          JSON.stringify({ held: 'get_state' }) + '\n',
        );
      } else reply(data);
      break;
    }
    case 'get_available_models':
      reply({ models: [model] });
      break;
    case 'get_available_thinking_levels':
      reply({ levels: ['off', 'low', 'high'] });
      break;
    case 'set_thinking_level':
      thinking = cmd.level;
      reply({});
      break;
    case 'set_model':
      if (process.env.PI_TEST_MODEL_RESETS_THINKING) thinking = 'low';
      reply(model);
      break;
    case 'get_commands':
      reply({
        commands: process.env.PI_TEST_FAST_MODE
          ? [{ name: 'workbench-fast', source: 'extension' }]
          : [],
      });
      break;
    case 'get_entries':
      reply({ entries: fastEntries, leafId: fastEntries.at(-1)?.id ?? null });
      break;
    case 'get_messages':
      reply({ messages });
      break;
    case 'get_session_stats': {
      const emit = () =>
        reply({
          tokens: { input: 100, output: 20, cacheRead: 800, cacheWrite: 100, total: 1020 },
          contextUsage: {
            tokens: contextTokens,
            contextWindow: 200000,
            percent: contextTokens === null ? null : contextTokens / 2000,
          },
          cost: 0.01,
        });
      if (control && existsSync(control + '.stats-hold')) statsReplies.push(emit);
      else emit();
      break;
    }
    case 'compact':
      if (cmd.customInstructions === 'fail') {
        send({
          type: 'response',
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: 'compaction model unavailable',
        });
      } else {
        contextTokens = null;
        reply({ tokensBefore: 1020, summary: '手动压缩后的上下文' });
      }
      break;
    case 'clear_queue':
      queuedPrompts = [];
      reply({ steering: [], followUp: [] });
      break;
    case 'abort':
      wakeActive = false;
      queuedPrompts = [];
      if (heldStateReply) {
        unlinkSync(process.env.PI_TEST_PREFLIGHT_FLAG);
        const release = heldStateReply;
        heldStateReply = undefined;
        setTimeout(release, 100);
      }
      reply({});
      send({ type: 'agent_end', messages });
      send({ type: 'agent_settled' });
      break;
    case 'prompt': {
      if (control && existsSync(control + '.race') && !cmd.message.startsWith('/')) {
        unlinkSync(control + '.race');
        startWake();
      }
      if (wakeActive) {
        if (cmd.streamingBehavior !== 'followUp') {
          send({
            type: 'response',
            id: cmd.id,
            command: cmd.type,
            success: false,
            error: 'Agent is streaming',
          });
          break;
        }
        queuedPrompts.push(cmd);
        reply({ disposition: 'queued' });
        break;
      }
      contextTokens = 1020;
      if (process.env.PI_TEST_FAST_MODE && cmd.message.startsWith('/workbench-fast ')) {
        const entry = {
          type: 'custom',
          id: randomUUID(),
          parentId: fastEntries.at(-1)?.id ?? null,
          customType: 'pi-acp-workbench/fast-mode',
          data: { version: 1, enabled: cmd.message.endsWith(' on') },
        };
        fastEntries.push(entry);
        appendFileSync(file, JSON.stringify(entry) + '\n');
        reply({ disposition: 'handled' });
        break;
      }
      reply({});
      if (cmd.message === 'MODEL_ERROR') {
        const message = {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '<html><body>Unable to load site</body></html>',
        };
        send({ type: 'message_end', message });
        send({ type: 'auto_retry_end', success: false });
        send({ type: 'agent_end', messages: [message] });
        send({ type: 'agent_settled' });
        break;
      }
      const message = {
        role: 'assistant',
        provider: model.provider,
        model: model.id,
        api: model.api,
        content: [{ type: 'text', text: '完成，公式 $x^2$。' }],
        usage: { input: 100, output: 20, cacheRead: 800, cacheWrite: 100, cost: { total: 0.001 } },
        timestamp: Date.now(),
        stopReason: 'stop',
      };
      messages.push({ role: 'user', content: cmd.message }, message);
      append({ type: 'message', message });
      {
        const compaction = {
          type: 'compaction',
          summary: '压缩后的历史摘要',
          firstKeptEntryId: 'kept',
          usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0003 } },
        };
        append(compaction);
        messages = [{ role: 'compactionSummary', summary: compaction.summary }, message];
      }
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'user', content: cmd.message } });
      send({ type: 'message_start', message: { ...message, content: [] } });
      send({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: message.content[0].text,
        },
      });
      send({ type: 'message_end', message });
      send({ type: 'turn_end', message, toolResults: [] });
      const finish = () => {
        send({ type: 'agent_end', messages });
        send({ type: 'agent_settled' });
      };
      if (cmd.message === 'LONG_CONTEXT') setTimeout(finish, 2200);
      else finish();
      break;
    }
    default:
      reply({});
  }
}
if (process.env.PI_TEST_WAKE_ON_RESTORE && process.argv.includes('--session')) startWake();
createInterface({ input: process.stdin }).on('line', handleCommand);
