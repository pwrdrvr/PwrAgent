import type { AgentEvent } from "@pwragent/shared/contracts/agent";

/** Saved viewer membership changes the operator queue's read scope. */
export function changesOperatorQueueMounts({ notification, federationTarget }: AgentEvent): boolean {
  return federationTarget?.scope !== "remote"
    && notification.method === "navigation/remoteThreadPins/changed"
    && (notification.params.membershipChanged === true
      || (notification.params.membershipChanged !== false && notification.params.pinned !== undefined));
}
