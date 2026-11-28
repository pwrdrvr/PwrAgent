import type { FactoryAdmissionRow, FactoryOwner } from "@pwragent/owner-core/factory-admission";
import { parseFactoryWorkItem } from "@pwragent/shared/factory-work-item";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";

export function localFactoryOwner(federation: DesktopFederationRuntime, leaseHeld: () => boolean): FactoryOwner | undefined {
  const instanceId = federation.knownLocalInstanceId();
  const machineId = instanceId && federation.factoryExecutorHost(instanceId)?.machineId;
  return instanceId && machineId && leaseHeld() ? { instanceId, machineId } : undefined;
}

export async function registeredFactoryProject(projectKey: string): Promise<string | undefined> {
  const launchpad = await getDesktopOverlayStore().getDirectoryLaunchpad({ directoryKey: projectKey });
  if (launchpad?.registeredAt && launchpad.federationTarget?.scope !== "remote") return launchpad.directoryPath;
}

export function approvalWorkItem(row: FactoryAdmissionRow) {
  return "workItem" in row && row.workItem !== undefined
    ? parseFactoryWorkItem({ workItem: row.workItem })
    : parseFactoryWorkItem({ issueId: row.issueId });
}

export function sameFactoryOwner(owner: FactoryOwner | undefined, expected: FactoryOwner): boolean {
  return owner?.instanceId === expected.instanceId && owner.machineId === expected.machineId;
}
