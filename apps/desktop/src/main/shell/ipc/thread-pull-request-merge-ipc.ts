import { ipcMain, type WebContents } from "electron";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { getDesktopAppServerService } from "../../app-server/desktop-app-server-service";
import { assertMergeNotHeld } from "../../app-server/thread-dependency-merge-hold";
import { getMainLogger } from "../../log";
import { GithubPrFetcher } from "../../pr-status/github-pr-fetcher";
import {
  mergeThreadPullRequest,
  readThreadPullRequestMerge,
  type ThreadPullRequestMergeDeps,
} from "../../pr-status/thread-pull-request-merge";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import { getDesktopOverlayStore } from "../../storage/desktop-overlay-store";
import { createThreadDependencyStorage } from "../../storage/desktop-runtime-storage";
import { readProjectMergeMethodPreference } from "../../thread-todos/thread-todo-runtime";
import {
  THREAD_PULL_REQUEST_MERGE_CHANNEL,
  THREAD_PULL_REQUEST_READ_MERGE_CHANNEL,
} from "../../../shared/ipc";
import { federationTargetForChannelSubscriber } from "../window-channels";

const mergeLog = getMainLogger("pwragent:pr-card-merge");

/** The same pieces a to-do merge card runs through. */
function desktopMergeDeps(): ThreadPullRequestMergeDeps {
  const overlay = getDesktopOverlayStore();
  const registry = getDesktopBackendRegistry();
  return {
    readThreadPullRequestUrls: (thread) => overlay.readThreadPullRequestUrls(thread),
    readPreference: async (thread) => await readProjectMergeMethodPreference(registry, thread),
    defaultMethod: () => getDesktopSettingsService().resolveDefaultMergeMethod(),
    resolveCwd: async (thread) => await registry.resolveThreadWorkspaceCwd(thread.backend, thread.threadId)
      .catch(() => undefined),
    assertNotHeld: (thread, url) => assertMergeNotHeld(createThreadDependencyStorage().active(), {
      ...thread, pullRequest: url,
    }, (owner) => overlay.readThreadPullRequestUrls(owner)),
    merge: async (params) => await new GithubPrFetcher().mergePullRequest(params),
    refresh: async (thread) => await getDesktopAppServerService().refreshOwnedThreadPullRequests({
      backend: thread.backend, threadId: thread.threadId, trigger: "user",
    }),
    onRefreshFailed: (error) => mergeLog.warn("could not refresh PR status after a merge", {
      error: error instanceof Error ? error.message : String(error),
    }),
  };
}

/**
 * PR card merges act on this machine's threads only: a federation viewer's
 * thread keeps its merge, and its holds, on its owner.
 */
function assertLocalWindow(sender: WebContents): void {
  if (federationTargetForChannelSubscriber(sender)) {
    throw new Error("Merge this pull request from the PwrAgent that owns its thread.");
  }
}

export function registerThreadPullRequestMergeIpcHandlers(): void {
  ipcMain.removeHandler(THREAD_PULL_REQUEST_READ_MERGE_CHANNEL);
  ipcMain.handle(THREAD_PULL_REQUEST_READ_MERGE_CHANNEL, async (event, request) => {
    assertLocalWindow(event.sender);
    return await readThreadPullRequestMerge(desktopMergeDeps(), request);
  });
  ipcMain.removeHandler(THREAD_PULL_REQUEST_MERGE_CHANNEL);
  ipcMain.handle(THREAD_PULL_REQUEST_MERGE_CHANNEL, async (event, request) => {
    assertLocalWindow(event.sender);
    return await mergeThreadPullRequest(desktopMergeDeps(), request);
  });
}
