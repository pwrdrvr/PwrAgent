import type { IpcRenderer } from "electron";
import {
  PASTE_WITHOUT_FORMATTING_CHANNEL,
  PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL,
} from "../shared/plain-text-paste";

// One dispatcher per window: inactive composers must not each trigger a
// native fallback. Only the focused editor claims a request.
export function createPlainTextPasteSubscription(
  ipc: Pick<IpcRenderer, "on" | "send">,
): (callback: (text: string) => boolean) => () => void {
  const listeners = new Set<(text: string) => boolean>();
  ipc.on(PASTE_WITHOUT_FORMATTING_CHANNEL, (_event, text: unknown) => {
    if (typeof text !== "string") return;
    for (const listener of listeners) {
      if (listener(text)) return;
    }
    ipc.send(PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL);
  });
  return (callback) => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  };
}
