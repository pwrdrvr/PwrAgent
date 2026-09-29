import type { WebContents } from "electron";
import { WINDOW_SHOW_THREAD_CHANNEL } from "../shared/ipc";
import { isFederationWindowWebContents } from "./window";
import { subscribersForChannel } from "./window-channels";

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
