import type * as acp from '@agentclientprotocol/sdk';
import type { ChatState } from './shared';
let serial = 0;
export const nextId = () => `entry-${Date.now()}-${++serial}`;
export function initialState(): ChatState {
  return { status: 'disconnected', entries: [], attachments: [], commands: [], plan: [], history: [], permissions: [], showThoughts: true, preview: false, contextComplete: true };
}
export function appendText(state: ChatState, role: 'user' | 'assistant' | 'thought' | 'notice', text: string, messageId?: string | null) {
  const last = state.entries.at(-1);
  if (last?.role === role && role !== 'notice' && (!messageId || last.messageId === messageId)) {
    state.entries[state.entries.length - 1] = {...last, text:last.text + text};
  } else state.entries.push({ id: nextId(), messageId, role, text });
}
export function applyUpdate(state: ChatState, update: acp.SessionUpdate, replay = false) {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (update.sessionUpdate === 'user_message_chunk' && !replay) break;
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'assistant';
      const c = update.content;
      const text = c.type === 'text' ? c.text : c.type === 'resource_link' ? `[${c.name}](${c.uri})` : c.type === 'resource' ? ('text' in c.resource ? c.resource.text : '[二进制资源]') : `[${c.type} 内容]`;
      appendText(state, role, text, update.messageId);
      if (c.type !== 'text') {
        const entry = state.entries.at(-1)!;
        if (entry.role === 'user' || entry.role === 'assistant' || entry.role === 'thought') {
          state.entries[state.entries.length - 1] = {...entry, contextBlocks:[...entry.contextBlocks || [], structuredClone(c)]};
        }
      }
      break;
    }
    case 'tool_call':
    case 'tool_call_update': {
      const index = state.entries.findIndex(e => e.role === 'tool' && e.tool.toolCallId === update.toolCallId);
      const old = state.entries[index];
      const fields = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null));
      if (old?.role === 'tool') state.entries[index] = {...old, tool:{...old.tool, ...fields}};
      else state.entries.push({ id: nextId(), role: 'tool', tool: { title: '工具调用', status: 'pending', ...fields, toolCallId: update.toolCallId } as acp.ToolCall });
      break;
    }
    case 'plan': state.plan = update.entries; break;
    case 'available_commands_update': state.commands = update.availableCommands; break;
    case 'current_mode_update': if (state.modes) state.modes.currentModeId = update.currentModeId; break;
    case 'config_option_update': state.configs = update.configOptions; break;
    case 'usage_update': state.usage = { used: update.used, size: update.size }; break;
  }
}
