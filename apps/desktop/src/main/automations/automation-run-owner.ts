import type { AutomationRunOwner } from "@pwragent/shared";
import {
  getProcessRuntimeIdentity,
  isProfileRuntimeIdentityLive,
  resolveActiveProfileName,
} from "../profile.js";

/** This process, as its profile runtime marker identifies it. */
export function getAutomationRunOwner(): AutomationRunOwner {
  const identity = getProcessRuntimeIdentity();
  return {
    instanceId: identity.instanceId,
    processId: process.pid,
    startedAt: identity.startedAt,
  };
}

/**
 * The check Research runs use for a foreign owner: the recorded instance ID,
 * process ID and start time must all match a live runtime marker of this
 * profile. An owner recorded without a start time cannot be matched, so it is
 * dead. This process is alive without consulting its own marker.
 */
export function isAutomationRunOwnerAlive(owner: AutomationRunOwner): boolean {
  const self = getAutomationRunOwner();
  if (owner.instanceId === self.instanceId && owner.processId === self.processId) {
    return true;
  }
  return owner.startedAt !== undefined
    && isProfileRuntimeIdentityLive(resolveActiveProfileName(), {
      instanceId: owner.instanceId,
      processId: owner.processId,
      startedAt: owner.startedAt,
    });
}
