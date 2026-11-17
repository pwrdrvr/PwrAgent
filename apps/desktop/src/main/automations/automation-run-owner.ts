import type { AutomationRunOwner } from "@pwragent/shared";
import {
  getProcessRuntimeIdentity,
  isProcessAlive,
  isProfileRuntimeIdentityLive,
  resolveActiveProfileName,
} from "../profile.js";

/**
 * `unconfirmed`: the owner's process ID is alive but no fresh runtime marker
 * matches it. That is a live owner whose marker aged out (the machine just
 * woke, or its main thread was busy) or a crashed owner whose process ID was
 * reused. Only time tells them apart: a live owner rewrites its marker within
 * one heartbeat.
 */
export type AutomationRunOwnerLiveness = "alive" | "dead" | "unconfirmed";

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
 * dead. This process is alive without consulting its own marker. A marker
 * expires 45 seconds after its last heartbeat, so an owner with no match is
 * dead only once its process is gone too.
 */
export function readAutomationRunOwnerLiveness(
  owner: AutomationRunOwner,
): AutomationRunOwnerLiveness {
  const self = getAutomationRunOwner();
  if (owner.instanceId === self.instanceId && owner.processId === self.processId) {
    return "alive";
  }
  if (owner.startedAt === undefined) return "dead";
  if (
    isProfileRuntimeIdentityLive(resolveActiveProfileName(), {
      instanceId: owner.instanceId,
      processId: owner.processId,
      startedAt: owner.startedAt,
    })
  ) return "alive";
  return isProcessAlive(owner.processId) ? "unconfirmed" : "dead";
}
