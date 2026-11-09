import path from "node:path";
import { stat } from "node:fs/promises";
import { shell } from "electron";
import { isToolManagedWorktreePath, type ThreadMaintenanceRun } from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { checkoutHibernationReviewDeps, ThreadMaintenanceService } from "./app-server/thread-maintenance-service";
import { MAX_WORKTREE_SNAPSHOT_BYTES } from "./app-server/worktree-archive-service";
import { getDesktopFederationRuntime } from "./federation/federation-runtime";
import { getMainLogger } from "./log";
import { measureMaintenanceAllocation } from "./app-server/maintenance-disk-usage";
import { scanCargoBuildOutputs, removeCargoBuildOutput } from "./app-server/maintenance-cargo-output";

const maintenanceLog = getMainLogger("pwragent:thread-maintenance");

let service: ThreadMaintenanceService | undefined;
const runListeners = new Set<(run: ThreadMaintenanceRun) => void>();

/** The one Thread maintenance service for this process. The dialog and the
 * agent tools share it, so a run started by either is visible to both. */
export function getThreadMaintenanceService(): ThreadMaintenanceService {
  return service ??= new ThreadMaintenanceService({
    getPolicy: () => getDesktopBackendRegistry().getThreadArchivePolicy(),
    snapshotLimitBytes: MAX_WORKTREE_SNAPSHOT_BYTES,
    listCandidates: async (onProgress) => await getDesktopBackendRegistry().listAutoArchiveCandidates(onProgress),
    listPeerSubthreads: async () => await getDesktopFederationRuntime().peerSubthreadsOfLocalThreads(),
    resolveProject: async (candidate) => await getDesktopBackendRegistry().resolveAutoArchiveProject(candidate),
    refreshCandidate: async (candidate) => await getDesktopBackendRegistry().refreshArchiveCandidate(candidate),
    isBusy: (candidate) => getDesktopBackendRegistry().isArchiveCandidateBusy(candidate),
    auditArchivedCheckouts: async (onProgress) => await getDesktopBackendRegistry().auditArchivedCheckouts(onProgress),
    measureAllocation: measureMaintenanceAllocation,
    buildOutputs: { scan: scanCargoBuildOutputs, remove: removeCargoBuildOutput },
    isCheckoutOnDisk: async (checkout) => {
      try { return (await stat(checkout)).isDirectory(); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    },
    archiveFamily: async (family, options) => {
      const { thread } = family[0]!;
      const registry = getDesktopBackendRegistry();
      // The same path as the Archive button: peers ungroup the children first.
      await getDesktopFederationRuntime().ungroupRemoteChildrenOfArchivedThread({
        backend: thread.source, parentThreadId: thread.id,
      });
      if (options.snapshotLimitBytes) {
        registry.approveReviewedSnapshotLimit(thread.source, thread.id, options.snapshotLimitBytes);
      }
      try {
        await registry.archiveThread({ backend: thread.source, threadId: thread.id,
          preserveWorktrees: options.preserveWorktrees });
      } finally {
        if (options.snapshotLimitBytes) registry.clearReviewedSnapshotLimit(thread.source, thread.id);
      }
      return true;
    },
    removeArchivedCheckouts: async (selection) => await getDesktopBackendRegistry().removeArchivedCheckouts(selection),
    hibernation: checkoutHibernationReviewDeps(getDesktopBackendRegistry),
    isManagedCheckoutPath: isManagedCheckoutRoot,
    trashItem: async (absolutePath) => await shell.trashItem(absolutePath),
    onRun: (run) => {
      for (const listener of runListeners) listener(run);
    },
    onError: (error, context) => maintenanceLog.warn("thread maintenance item failed", {
      ...context, error: error instanceof Error ? error.message : String(error),
    }),
  });
}

export function onThreadMaintenanceRun(listener: (run: ThreadMaintenanceRun) => void): () => void {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}

export function disposeThreadMaintenanceService(): void {
  service?.dispose();
  service = undefined;
}

/** A checkout folder itself at either supported tool-root depth. Git's
 * missing-repository probe still proves it is a checkout before Trash. */
export function isManagedCheckoutRoot(worktreePath: string): boolean {
  const resolved = path.resolve(worktreePath);
  return (isToolManagedWorktreePath(resolved) || isToolManagedWorktreePath(path.join(resolved, "checkout")))
    && (path.basename(path.dirname(path.dirname(resolved))) === "worktrees"
      || path.basename(path.dirname(resolved)) === "worktrees");
}
