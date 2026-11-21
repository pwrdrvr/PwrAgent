import { ipcMain } from "electron";
import type {
  ReadWorktreeReflinkCapabilitiesRequest,
  ReadWorktreeReflinkCapabilitiesResponse,
  RunWorktreeReflinkRequest,
  RunWorktreeReflinkResponse,
  WorktreeReflinkTarget,
} from "@pwragent/shared/contracts/worktree-reflink";
import {
  WORKTREE_REFLINK_CAPABILITIES_CHANNEL,
  WORKTREE_REFLINK_RUN_CHANNEL,
} from "../../../shared/ipc";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { getWorktreeReflinkService } from "../../git-worktree-reflink";
import { isFederationWindowWebContents } from "../window";

const REMOTE_THREAD_REASON = "Worktree storage is shared on the machine that owns the thread.";
const UNLINKED_REASON = "This directory is not linked to the thread.";
const UNANSWERED_REASON = "The selected Git could not be run in this thread's directories.";

/**
 * The directory Git runs in is the thread's own record of it, never the
 * renderer's string: sharing rewrites files, so a path must be one this
 * instance linked to a thread that is not archived. A federation window
 * shows another machine's paths, which name nothing here.
 */
async function resolveTarget(
  sender: Electron.WebContents | undefined,
  target: WorktreeReflinkTarget,
): Promise<{ cwd: string; others: string[] } | { reason: string }> {
  if (isFederationWindowWebContents(sender)) return { reason: REMOTE_THREAD_REASON };
  const workspace = await getDesktopBackendRegistry().resolveThreadLinkedWorkspace({
    backend: target.backend,
    threadId: target.threadId,
    worktreePath: target.worktreePath,
  });
  if (!workspace) return { reason: UNLINKED_REASON };
  return {
    cwd: workspace.worktreePath,
    others: workspace.workspacePaths.filter((entry) => entry !== workspace.worktreePath),
  };
}

export function registerWorktreeReflinkIpc(): void {
  unregisterWorktreeReflinkIpc();
  ipcMain.handle(
    WORKTREE_REFLINK_CAPABILITIES_CHANNEL,
    async (
      event,
      request: ReadWorktreeReflinkCapabilitiesRequest,
    ): Promise<ReadWorktreeReflinkCapabilitiesResponse> => {
      const target = await resolveTarget(event?.sender, request);
      if ("reason" in target) return { status: "unavailable", reason: target.reason };
      // What Git can do is the same in any of the thread's repositories, so
      // a target that is hibernated or gone does not hide the answer.
      const { answered, ...runtime } = await getWorktreeReflinkService()
        .readCapabilities([target.cwd, ...target.others]);
      // "Cannot share" is a fact about a Git. Without an answer there is none.
      return answered ? { status: "ready", ...runtime } : { status: "unavailable", reason: UNANSWERED_REASON };
    },
  );
  ipcMain.handle(
    WORKTREE_REFLINK_RUN_CHANNEL,
    async (event, request: RunWorktreeReflinkRequest): Promise<RunWorktreeReflinkResponse> => {
      const target = await resolveTarget(event?.sender, request);
      if ("reason" in target) return { status: "failed", reason: target.reason };
      return await getWorktreeReflinkService().run({
        cwd: target.cwd,
        mode: request.mode === "share" ? "share" : "estimate",
        // Only the literal `true` opts in; anything else from the renderer is "no".
        verifyFilters: request.verifyFilters === true,
        runtimeKey: typeof request.runtimeKey === "string" ? request.runtimeKey : "",
        isBusy: () => getDesktopBackendRegistry().workspaceHasActiveTurn(target.cwd),
      });
    },
  );
}

export function unregisterWorktreeReflinkIpc(): void {
  ipcMain.removeHandler(WORKTREE_REFLINK_CAPABILITIES_CHANNEL);
  ipcMain.removeHandler(WORKTREE_REFLINK_RUN_CHANNEL);
}
