import { ipcMain } from "electron";
import type { ThreadPullRequestMergeTarget } from "@pwragent/shared/contracts/navigation";
import { getDesktopAppServerService } from "../../app-server/desktop-app-server-service";
import { getDesktopFederationRuntime } from "../../federation/federation-runtime";
import { desktopThreadPullRequestMergeDeps } from "../../pr-status/desktop-thread-pull-request-merge";
import {
  mergeThreadPullRequest,
  readThreadPullRequestMerge,
  type ThreadPullRequestMergeDeps,
} from "../../pr-status/thread-pull-request-merge";
import {
  mergeRemoteThreadPullRequest,
  readRemoteThreadPullRequestMerge,
  readThreadPullRequestMergeOwner,
} from "../../pr-status/thread-pull-request-merge-federation";
import {
  THREAD_PULL_REQUEST_MERGE_CHANNEL,
  THREAD_PULL_REQUEST_READ_MERGE_CHANNEL,
} from "../../../shared/ipc";
import { federationTargetForChannelSubscriber } from "../window-channels";

function localMergeDeps(): ThreadPullRequestMergeDeps {
  return desktopThreadPullRequestMergeDeps(async (thread) => await getDesktopAppServerService()
    .refreshOwnedThreadPullRequests({ backend: thread.backend, threadId: thread.threadId, trigger: "user" }));
}

/**
 * A peer's thread, named by the request or fronted by a viewer window, is
 * merged on its owner, which holds the thread's PRs, its Continue After
 * holds and the operator's `gh` for that checkout. This instance's threads
 * merge here.
 */
export function registerThreadPullRequestMergeIpcHandlers(): void {
  ipcMain.removeHandler(THREAD_PULL_REQUEST_READ_MERGE_CHANNEL);
  ipcMain.handle(THREAD_PULL_REQUEST_READ_MERGE_CHANNEL, async (event, request: ThreadPullRequestMergeTarget) => {
    const owner = readThreadPullRequestMergeOwner(request, federationTargetForChannelSubscriber(event.sender));
    if (owner) return await readRemoteThreadPullRequestMerge(request, owner, getDesktopFederationRuntime());
    return await readThreadPullRequestMerge(localMergeDeps(), request);
  });
  ipcMain.removeHandler(THREAD_PULL_REQUEST_MERGE_CHANNEL);
  ipcMain.handle(THREAD_PULL_REQUEST_MERGE_CHANNEL, async (event, request: ThreadPullRequestMergeTarget) => {
    const owner = readThreadPullRequestMergeOwner(request, federationTargetForChannelSubscriber(event.sender));
    if (owner) return await mergeRemoteThreadPullRequest(request, owner, getDesktopFederationRuntime());
    return await mergeThreadPullRequest(localMergeDeps(), request);
  });
}
