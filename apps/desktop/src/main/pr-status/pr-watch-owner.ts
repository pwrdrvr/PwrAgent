import { randomUUID } from "node:crypto";
import { getProcessRuntimeIdentity, isProcessAlive, readProfileRuntimeIdentities } from "../profile";

const OWNER_KIND = "pr-watch-runtime-v1";

export function createPrWatchOwnerId(): string {
  return JSON.stringify({
    kind: OWNER_KIND,
    ...getProcessRuntimeIdentity(),
    processId: process.pid,
    // Keep coordinators in one process fenced from each other's completions.
    claimId: randomUUID(),
  });
}

/** Undefined means an older opaque owner with no conclusive runtime evidence. */
function ownerIsAlive(ownerId: string | null): boolean | undefined {
  try {
    const owner = JSON.parse(ownerId ?? "null") as Record<string, unknown> | null;
    if (owner?.kind === OWNER_KIND
      && typeof owner.processId === "number" && Number.isInteger(owner.processId) && owner.processId > 0
      && typeof owner.instanceId === "string" && typeof owner.startedAt === "number") {
      if (owner.processId === process.pid) {
        const current = getProcessRuntimeIdentity();
        return owner.instanceId === current.instanceId && owner.startedAt === current.startedAt;
      }
      // Never take work from a live PID because its lease or marker aged out.
      // A reused sibling PID is conservatively protected until it exits.
      return isProcessAlive(owner.processId);
    }
  } catch { /* Opaque UUIDs from earlier versions have no process identity. */ }

  const current = getProcessRuntimeIdentity();
  const identities = readProfileRuntimeIdentities();
  // An opaque claim can be recovered immediately only when the current
  // process is the sole runtime. Otherwise we cannot identify its owner.
  if (!identities?.some((identity) => identity.instanceId === current.instanceId
    && identity.processId === process.pid && identity.startedAt === current.startedAt)) return undefined;
  return identities.some((identity) => identity.instanceId !== current.instanceId || identity.processId !== process.pid);
}

export function canReclaimPrWatchLease(ownerId: string | null, expiresAt: number | null, now: number): boolean {
  const alive = ownerIsAlive(ownerId);
  return alive === undefined ? (expiresAt ?? 0) <= now : !alive;
}
