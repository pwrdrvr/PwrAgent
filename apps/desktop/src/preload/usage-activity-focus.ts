import type { IpcRenderer } from "electron";
import { USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL } from "../shared/ipc";

/**
 * Listen for Usage Activity focus requests from the first moment the preload
 * runs. A request can arrive while the window is still loading, before React
 * subscribes; the newest one waits for that subscriber.
 */
export function createUsageActivityFocusSubscription(
  ipc: Pick<IpcRenderer, "on">,
): (callback: (provider: string) => void) => () => void {
  const listeners = new Set<(provider: string) => void>();
  let pending: string | undefined;
  ipc.on(USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL, (_event, provider: unknown) => {
    if (typeof provider !== "string") return;
    if (listeners.size === 0) {
      pending = provider;
      return;
    }
    for (const listener of listeners) listener(provider);
  });
  return (callback) => {
    listeners.add(callback);
    const waiting = pending;
    pending = undefined;
    if (waiting) callback(waiting);
    return () => {
      listeners.delete(callback);
    };
  };
}
