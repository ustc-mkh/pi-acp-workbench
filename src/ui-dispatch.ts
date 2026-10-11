import type { UiMessage } from './shared';
export interface UiPolicy {
  gated?: boolean;
  navigation?: boolean;
  /** Surface lifecycle refusals as errors instead of silently dropping the intent. */
  reportRefusal?: boolean;
}
export type UiHandlers = {
  [Type in UiMessage['type']]: UiPolicy & {
    run: (message: UiMessage & { type: Type }) => void | Promise<void>;
    /** Record a per-intent result for dialogs awaiting a reply; called for the current generation only. */
    fail?: (message: UiMessage & { type: Type }, detail: string) => void;
  };
};
/** The mapped table proves every intent is handled; validation happens before indexing. */
export function dispatchUi(handlers: UiHandlers, message: UiMessage) {
  return (handlers[message.type].run as (message: UiMessage) => void | Promise<void>)(message);
}
export function failUi(handlers: UiHandlers, message: UiMessage, detail: string) {
  (handlers[message.type].fail as ((message: UiMessage, detail: string) => void) | undefined)?.(
    message,
    detail,
  );
}
