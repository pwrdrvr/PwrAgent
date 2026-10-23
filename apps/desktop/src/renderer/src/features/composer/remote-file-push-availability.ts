import type { FederationHealthStatus } from "@pwragent/shared";
import { buildFederationPeerTargets } from "../chrome/federation-thread-targets";

/**
 * Whether a remote thread's owner can take a file from this machine right
 * now. Mirrors the checks in the federation runtime's `pushFile`, so a file
 * the composer offers to send is one main will try to send.
 *
 * `unknown` means federation health has not loaded yet. The composer still
 * tries: main checks again, and a refusal shows on the file's own pill.
 */
export type RemoteFilePushAvailability =
  | "available"
  | "unknown"
  | "offline"
  | "update-required"
  | "incoming-off";

export type RemoteFilePushTarget = {
  availability: RemoteFilePushAvailability;
  /** The owner's display name, as thread-action menus show it. */
  label: string;
};

export function resolveRemoteFilePushTarget(
  health: FederationHealthStatus | undefined,
  instanceId: string,
): RemoteFilePushTarget {
  const target = buildFederationPeerTargets(health, (peer) => {
    if (!peer.capabilities.includes("file_push")) return "update-required";
    if (peer.status !== "connected") return "offline";
    return peer.receiverPermissions?.filePush === true
      ? "available"
      : "incoming-off";
  }).find((candidate) => candidate.instanceId === instanceId);
  return target
    ? { availability: target.availability, label: target.label }
    : { availability: "unknown", label: "the owning machine" };
}

export function canPushToRemoteTarget(target: RemoteFilePushTarget): boolean {
  return target.availability === "available" || target.availability === "unknown";
}

/** Toast copy for a refused drop, paste, or pick. */
export function describeRemoteFilePushRefusal(
  target: RemoteFilePushTarget,
): { title: string; message: string } | undefined {
  const title = `Can't send files to ${target.label}`;
  switch (target.availability) {
    case "incoming-off":
      return {
        title,
        message: "Turn on Allow file push in that machine's Federation settings.",
      };
    case "offline":
      return { title, message: "That machine is not connected." };
    case "update-required":
      return { title, message: "Update PwrAgent on that machine to send files." };
    default:
      return undefined;
  }
}

/** Tooltip for the "Add file…" action while the owner cannot receive. */
export function describeRemoteFilePushTooltip(
  target: RemoteFilePushTarget,
): string | undefined {
  const refusal = describeRemoteFilePushRefusal(target);
  return refusal ? `${refusal.title}. ${refusal.message}` : undefined;
}
