import type { WebContents } from "electron";
import { WINDOW_SHOW_THREAD_CHANNEL } from "../../shared/ipc";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";
import { isFederationWindowWebContents } from "./window";
import { subscribersForChannel } from "./window-channels";
import { requestShowThread } from "./window-show-thread";

/**
 * The main window that auxiliary windows (Star Map, Usage Activity) target
 * for cross-window actions. Federation remote-viewer windows subscribe to the
 * same channel but front another instance's threads, so they are never a
 * valid target for a local thread.
 */
export function primaryMainWindowWebContents(): WebContents | undefined {
  return subscribersForChannel(WINDOW_SHOW_THREAD_CHANNEL).find(
    (subscriber) => !isFederationWindowWebContents(subscriber),
  );
}

/**
 * An auxiliary window's request to show a thread in the main window. A
 * request without a backend and thread id is ignored, as is one sent while
 * no main window is open.
 */
export function requestShowThreadInPrimaryMainWindow(request: WindowShowThreadRequest | undefined): void {
  if (typeof request?.backend !== "string" || typeof request?.threadId !== "string") return;
  const target = primaryMainWindowWebContents();
  if (target) requestShowThread(request, { preferWebContents: target });
}
