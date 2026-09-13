import type { IpcRenderer } from "electron";
import type { GithubPrAuthenticationFailureEvent } from "../shared/github-pr-access";
import {
  GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
} from "../shared/ipc";

export function subscribeGithubPrAuthenticationFailure(
  ipc: Pick<IpcRenderer, "on" | "off" | "invoke">,
  callback: (event: GithubPrAuthenticationFailureEvent) => void,
): () => void {
  const listener = (
    _event: Electron.IpcRendererEvent,
    payload: GithubPrAuthenticationFailureEvent,
  ) => {
    callback(payload);
    // Window registration precedes React mounting. Only acknowledge an event
    // after the actual consumer receives it, never merely after main sends it.
    void ipc.invoke(GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL).catch(() => {
      // Main may be shutting down. An unacknowledged notice can be retried.
    });
  };
  ipc.on(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL, listener);
  return () => ipc.off(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL, listener);
}
