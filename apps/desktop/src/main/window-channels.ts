import type { BrowserWindow, WebContents } from "electron";

/**
 * Per-window channel-subscription registry.
 *
 * Why: messaging-status broadcasts (and any future push-event channel)
 * used to fan out to `BrowserWindow.getAllWindows()` — meaning a
 * second BrowserWindow that didn't care about a channel still paid
 * the IPC + JSON serialize/deserialize cost in its own renderer
 * process. As secondary windows accumulate (Messaging Activity now,
 * possibly Settings-as-window or a Diagnostics surface later), this
 * scales linearly with no opt-in.
 *
 * How it works:
 *
 * 1. At creation, each window calls `registerWindowChannels(window,
 *    kind, channels)` listing the channels its renderer subscribes
 *    to. The main window registers ALL channels (it's the canonical
 *    receiver); the activity window registers `[]` because it polls.
 * 2. Broadcasters call `subscribersForChannel(channel)` and only
 *    iterate the returned `WebContents` set. Skipped windows pay zero
 *    cost.
 * 3. Cleanup is automatic via the window's `closed` event — the
 *    registry entry is dropped before the broadcaster has a chance to
 *    iterate a destroyed window.
 *
 * The registry is keyed by `WebContents` (each `BrowserWindow` has
 * exactly one) so it survives reparenting and matches the API
 * broadcasters actually use (`window.webContents.send`).
 */

/** Identifier for each known window kind. Keep in sync with the
 *  per-window registration sites. */
export const WINDOW_KIND_MAIN = "main" as const;
export const WINDOW_KIND_MESSAGING_ACTIVITY = "messaging-activity" as const;
export const WINDOW_KIND_CHANGELOG = "changelog" as const;
export type WindowKind =
  | typeof WINDOW_KIND_MAIN
  | typeof WINDOW_KIND_MESSAGING_ACTIVITY
  | typeof WINDOW_KIND_CHANGELOG;

interface Entry {
  kind: WindowKind;
  channels: Set<string>;
  webContents: WebContents;
}

const entries = new Map<WebContents, Entry>();

export function registerWindowChannels(
  window: BrowserWindow,
  kind: WindowKind,
  channels: readonly string[],
): void {
  const webContents = window.webContents;
  entries.set(webContents, {
    kind,
    channels: new Set(channels),
    webContents,
  });
  window.on("closed", () => {
    entries.delete(webContents);
  });
}

/** Return every WebContents that has subscribed to the given channel. */
export function subscribersForChannel(channel: string): WebContents[] {
  const result: WebContents[] = [];
  for (const entry of entries.values()) {
    if (entry.channels.has(channel) && !entry.webContents.isDestroyed()) {
      result.push(entry.webContents);
    }
  }
  return result;
}

/**
 * For diagnostics / testing: return all currently registered windows.
 * Not used in production code paths.
 */
export function debugListRegisteredWindows(): Array<{
  kind: WindowKind;
  channels: string[];
}> {
  return Array.from(entries.values()).map((entry) => ({
    kind: entry.kind,
    channels: Array.from(entry.channels),
  }));
}

/** For tests only — drop all registrations. */
export function _resetWindowChannelsForTests(): void {
  entries.clear();
}
