import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { assertMergeNotHeld } from "../app-server/thread-dependency-merge-hold";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { createThreadDependencyStorage } from "../storage/desktop-runtime-storage";
import { readProjectMergeMethodPreference } from "../thread-todos/thread-todo-runtime";
import { GithubPrFetcher } from "./github-pr-fetcher";
import type { ThreadPullRequestMergeDeps } from "./thread-pull-request-merge";

const mergeLog = getMainLogger("pwragent:pr-card-merge");

/**
 * The same pieces a to-do merge card runs through, for this instance's own
 * threads. This window's merge and a peer's merge, which the owner runs for
 * it, both use them.
 */
export function desktopThreadPullRequestMergeDeps(
  refresh: ThreadPullRequestMergeDeps["refresh"],
): ThreadPullRequestMergeDeps {
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
    merge: async (params, thread) => await new GithubPrFetcher().mergePullRequest({ ...params, thread, checkStackOrder: true }),
    refresh,
    onRefreshFailed: (error) => mergeLog.warn("could not refresh PR status after enqueuing a merge", {
      error: error instanceof Error ? error.message : String(error),
    }),
  };
}
