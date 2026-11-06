import path from "node:path";
import { shell } from "electron";
import { isToolManagedWorktreePath, type ThreadMaintenanceRun } from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { ThreadMaintenanceService } from "./app-server/thread-maintenance-service";
import { MAX_WORKTREE_SNAPSHOT_BYTES } from "./app-server/worktree-archive-service";
import { getDesktopFederationRuntime } from "./federation/federation-runtime";
import { getMainLogger } from "./log";

const maintenanceLog = getMainLogger("pwragent:thread-maintenance");

let service: ThreadMaintenanceService | undefined;
const runListeners = new Set<(run: ThreadMaintenanceRun) => void>();

/** The one Thread maintenance service for this process. The dialog and the
 * agent tools share it, so a run started by either is visible to both. */
export function getThreadMaintenanceService(): ThreadMaintenanceService {
  return service ??= new ThreadMaintenanceService({
    getPolicy: () => getDesktopBackendRegistry().getThreadArchivePolicy(),
    snapshotLimitBytes: MAX_WORKTREE_SNAPSHOT_BYTES,
    listCandidates: async () => await getDesktopBackendRegistry().listAutoArchiveCandidates(),
    resolveProject: async (candidate) => await getDesktopBackendRegistry().resolveAutoArchiveProject(candidate),
    refreshCandidate: async (candidate) => await getDesktopBackendRegistry().refreshArchiveCandidate(candidate),
    isBusy: (candidate) => getDesktopBackendRegistry().isArchiveCandidateBusy(candidate),
    auditArchivedCheckouts: async () => await getDesktopBackendRegistry().auditArchivedCheckouts(),
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
    removeUnreferencedCheckouts: async (worktreePaths) => await getDesktopBackendRegistry().removeUnreferencedCheckouts(worktreePaths),
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

/** A checkout folder itself, directly under a PwrAgent or Codex worktree
 * root (`…/worktrees/<id>/<name>`), never a path inside one or the root. */
export function isManagedCheckoutRoot(worktreePath: string): boolean {
  const resolved = path.resolve(worktreePath);
  return isToolManagedWorktreePath(resolved)
    && path.basename(path.dirname(path.dirname(resolved))) === "worktrees";
}
