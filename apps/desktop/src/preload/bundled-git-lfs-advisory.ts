import type { IpcRenderer } from "electron";
import type { BundledGitLfsAdvisoryEvent } from "../shared/bundled-git-lfs";
import {
  BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL,
  BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL,
} from "../shared/ipc";

export function subscribeBundledGitLfsAdvisory(
  ipc: Pick<IpcRenderer, "on" | "off" | "invoke">,
  callback: (event: BundledGitLfsAdvisoryEvent) => void,
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    payload: BundledGitLfsAdvisoryEvent,
  ) => {
    callback(payload);
    // Window registration precedes React mounting. Only acknowledge an event
    // after the actual consumer receives it, never merely after main sends it.
    void ipc.invoke(BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL).catch(() => {
      // Main may be shutting down. An unacknowledged advisory can be retried.
    });
  };
  ipc.on(BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL, listener);
  return () => ipc.off(BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL, listener);
}
