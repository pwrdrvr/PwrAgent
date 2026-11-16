import type { ResearchPorts } from "@pwragent/owner-core/research-service";
import { getProcessRuntimeIdentity, isProfileRuntimeIdentityLive, resolveActiveProfileName } from "../profile";

/** Share the process identity already recorded by this profile's runtime marker. */
export function createResearchOwnerIdentity(): Pick<ResearchPorts, "ownerId" | "ownerPid" | "ownerStartedAt" | "isOwnerAlive"> {
  const identity = getProcessRuntimeIdentity();
  const profile = resolveActiveProfileName();
  return {
    ownerId: identity.instanceId, ownerPid: process.pid, ownerStartedAt: identity.startedAt,
    isOwnerAlive: (owner) => owner.ownerStartedAt !== undefined && isProfileRuntimeIdentityLive(profile, {
      instanceId: owner.ownerId, processId: owner.ownerPid, startedAt: owner.ownerStartedAt,
    }),
  };
}
