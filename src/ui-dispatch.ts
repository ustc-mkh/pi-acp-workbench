import type { UiMessage } from './shared';
export interface UiPolicy {
  gated?: boolean;
  navigation?: boolean;
}
export type UiHandlers = {
  [Type in UiMessage['type']]: UiPolicy & {
    run: (message: UiMessage & { type: Type }) => void | Promise<void>;
  };
};
/** The mapped table proves every intent is handled; validation happens before indexing. */
export function dispatchUi(handlers: UiHandlers, message: UiMessage) {
  return (handlers[message.type].run as (message: UiMessage) => void | Promise<void>)(message);
}
