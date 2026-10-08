import type { UiMessage } from './shared';
export type UiHandlers = {
  [Type in UiMessage['type']]: (message: UiMessage & { type: Type }) => void | Promise<void>;
};
/** The mapped table proves every intent is handled; the runtime key was checked by the caller. */
export function dispatchUi(handlers: UiHandlers, message: UiMessage) {
  // A discriminated union of callbacks loses correlation when indexed at runtime.
  return (handlers[message.type] as (message: UiMessage) => void | Promise<void>)(message);
}
