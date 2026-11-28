import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { getProcessRuntimeIdentity } from "../profile";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { createFactoryAdmissionStorage, createFactoryBranchReviewStorage } from "../storage/factory-admission-storage";
import { FactoryBranchReview } from "./factory-branch-review";
import { matchesFactoryOrigin } from "./factory-repository";

export function createOwnerFactoryBranchReview(
  registry: DesktopBackendRegistry, federation: DesktopFederationRuntime, leaseHeld: () => boolean,
): FactoryBranchReview {
  const admission = createFactoryAdmissionStorage();
  return new FactoryBranchReview({
    admission: (subject) => admission.read(subject),
    owner: () => {
      const instanceId = federation.knownLocalInstanceId();
      const machineId = instanceId && federation.factoryExecutorHost(instanceId)?.machineId;
      return instanceId && machineId && leaseHeld() ? { instanceId, machineId } : undefined;
    },
    project: async (projectKey) => {
      const project = await getDesktopOverlayStore().getDirectoryLaunchpad({ directoryKey: projectKey });
      return project?.registeredAt && project.federationTarget?.scope !== "remote" ? project.directoryPath : undefined;
    },
    originMatches: matchesFactoryOrigin,
    threadReady: async ({ target }) => {
      const key = { backend: "codex" as const, threadId: target.threadId };
      const state = await federation.localBackend().resolveThreadAdmissionState?.(key);
      const thread = state?.thread;
      if (!thread || thread.id !== key.threadId || thread.source !== key.backend
        || thread.workspaceMissing || thread.workspaceHibernated || thread.archivedAt !== undefined
        || state?.threadStatus !== "idle" || state.activeTurn || state.pendingRequest || thread.queuedTurns?.length
        || thread.linkedDirectories.length !== 1) return false;
      const directory = thread.linkedDirectories[0];
      return directory?.kind === "worktree" && directory.worktreeOwnership !== "external"
        && directory.worktreePath === target.worktreePath && directory.path !== directory.worktreePath;
    },
    start: (threadId, review) => registry.startPinnedManagedBranchReview(threadId, review),
    readResult: async (threadId, turnId) => {
      const thread = await getDesktopOverlayStore().getThreadOverlayState({ backend: "codex", threadId });
      return thread?.managedReviewEntries?.find((entry) => entry.id === `managed-review:${turnId}:result`);
    },
    runtimeId: getProcessRuntimeIdentity().instanceId,
    store: createFactoryBranchReviewStorage(),
  });
}
