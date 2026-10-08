import type { ChatState } from './shared';
let serial = 0;
export const nextId = () => `entry-${Date.now()}-${++serial}`;
export function initialState(): ChatState {
  return {
    status: 'disconnected',
    entries: [],
    attachments: [],
    commands: [],
    plan: [],
    history: [],
    permissions: [],
    showThoughts: true,
    preview: false,
    contextComplete: true,
  };
}
