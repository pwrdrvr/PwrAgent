import path from "node:path";
import { FactoryAdmission, type FactoryAdmissionPorts, type FactoryOwner } from "@pwragent/owner-core/factory-admission";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import { FACTORY_BUILDER_ISOLATION } from "@pwragent/shared/contracts/durable-turn-requests";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { matchesFactoryOrigin } from "./factory-repository";
import type { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { createFactoryAdmissionStorage } from "../storage/factory-admission-storage";
import { createFactoryCheckout } from "./factory-checkout";

const CALLER = "factory-admission-v1";

export function createOwnerFactoryAdmission(options: {
  federation: DesktopFederationRuntime;
  checkouts: DesktopResourceCheckoutService;
  leaseHeld(): boolean;
}): FactoryAdmission {
  const { federation, checkouts } = options;
  const owner = (): FactoryOwner | undefined => {
    const instanceId = federation.knownLocalInstanceId();
    const machineId = instanceId && federation.factoryExecutorHost(instanceId)?.machineId;
    return instanceId && machineId && options.leaseHeld() ? { instanceId, machineId } : undefined;
  };
  const targetFor = (instanceId: string): FederationRemoteTarget | undefined =>
    instanceId === federation.knownLocalInstanceId() ? undefined : { scope: "remote", instanceId };
  const backendFor = (target: FederationRemoteTarget | undefined) => target
    ? federation.remoteBackend(target) : federation.localBackend();
  const currentTarget = (target: FactoryOwner) => {
    if (target.machineId !== federation.factoryExecutorHost(target.instanceId)?.machineId) {
      throw new Error("The Factory executor identity is unavailable.");
    }
    return targetFor(target.instanceId);
  };
  const checkout = createFactoryCheckout((request) => checkouts.factoryCpu(request));
  const ports: FactoryAdmissionPorts = {
    store: createFactoryAdmissionStorage(),
    owner,
    project: async (projectKey, repository) => {
      const launchpad = await getDesktopOverlayStore().getDirectoryLaunchpad({ directoryKey: projectKey });
      if (!launchpad?.registeredAt || !launchpad.directoryPath || launchpad.federationTarget?.scope === "remote") return false;
      return matchesFactoryOrigin(launchpad.directoryPath, repository);
    },
    probe: async (row) => {
      const host = federation.factoryExecutorHost(row.target.instanceId);
      if (!host?.machineId || !host.platform || host.machineId !== row.target.machineId || host.platform !== row.platform
          || host.virtualMachine !== false || (host.codexSandbox && host.codexSandbox.status !== "ready")) return undefined;
      const target = targetFor(row.target.instanceId);
      const worktreePath = row.target.worktreePath;
      const pathApi = row.platform === "win32" ? path.win32 : path.posix;
      if (!pathApi.isAbsolute(worktreePath)) return undefined;
      const backend = backendFor(target);
      const subject = { backend: "codex" as const, threadId: row.target.threadId };
      const [load, state] = await Promise.all([backend.getLoadStatus(), backend.resolveThreadAdmissionState?.(subject)]);
      const thread = state?.thread;
      // The receiving registry attests from its post-preflight Outpost policy.
      if (state?.factoryBuilderIsolation !== FACTORY_BUILDER_ISOLATION || !thread || thread.workspaceMissing || thread.workspaceHibernated || thread.id !== subject.threadId || thread.source !== subject.backend || thread.archivedAt !== undefined
          || state.threadStatus !== "idle" || state.activeTurn || state.pendingRequest || thread.queuedTurns?.length
          || thread.linkedDirectories.length !== 1) return undefined;
      const [directory] = thread.linkedDirectories;
      if (directory?.kind !== "worktree" || directory.worktreeOwnership === "external"
          || directory.worktreePath !== worktreePath || directory.path === worktreePath) return undefined;
      const repoKey = `github.com/${row.repository}`;
      const matchesRepo = target
        ? directory.repositoryKey?.toLowerCase() === repoKey
        : await matchesFactoryOrigin(worktreePath, row.repository);
      if (!matchesRepo) return undefined;
      return { machineId: host.machineId, platform: host.platform, virtualMachine: host.virtualMachine, sampledAt: load.sampledAt };
    },
    resource: (machineId) => checkouts.factoryCpuResource(machineId),
    ...checkout,
    submit: (target, request) => federation.submitDurableTurnRequest(CALLER, request, currentTarget(target)),
    receipt: (target, request) => federation.getDurableTurnRequest(CALLER, request, currentTarget(target)),
    stop: async (target, receipt) => {
      const backend = backendFor(currentTarget(target));
      if (receipt.result?.queueStatus === "queued" && receipt.state === "accepted") {
        await backend.cancelQueuedTurn({ queueEntryId: receipt.queueEntryId });
      } else if (receipt.state === "dispatched" && receipt.result?.turnId) {
        await backend.controlActiveTurn?.({
          operation: "stop", backend: receipt.backend, threadId: receipt.threadId,
          requestId: `factory-cancel:${receipt.id}`, expectedTurnId: receipt.result.turnId,
        });
      }
    },
  };
  return new FactoryAdmission(ports);
}
