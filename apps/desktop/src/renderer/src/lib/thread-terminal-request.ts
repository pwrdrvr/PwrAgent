import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { resolveThreadTerminalCwd } from "@pwragent/shared/thread-terminal";
import type { IntegratedTerminalPaneRemote } from "./useIntegratedTerminals";

/**
 * Why the remote terminal toggle is inert for a federated thread — or
 * undefined when it can open (always undefined for local threads). Mirrors
 * the owner-side gate: the peer must be connected DIRECTLY and must have
 * granted `remote_pty`.
 */
export function resolveRemoteTerminalDisabledReason(
  federation: NavigationThreadSummary["federation"],
): string | undefined {
  if (!federation) {
    return undefined;
  }
  if (
    federation.peerStatus !== undefined &&
    federation.peerStatus !== "connected"
  ) {
    return `Remote terminal unavailable: ${federation.instanceLabel} is disconnected.`;
  }
  if (!federation.capabilities?.includes("remote_pty")) {
    return `Remote terminal not granted by ${federation.instanceLabel}.`;
  }
  return undefined;
}

/**
 * For a remote thread the create request must name the owning instance and
 * the pane wears its chip — the shell runs there, not on this machine.
 */
export function threadTerminalRemote(
  federation: NavigationThreadSummary["federation"],
): IntegratedTerminalPaneRemote | undefined {
  if (!federation || federation.ref.target.scope !== "remote") {
    return undefined;
  }
  return {
    target: federation.ref.target,
    instanceId: federation.ref.target.instanceId,
    instanceLabel: federation.instanceLabel,
    celestialIcon: federation.celestialIcon,
  };
}

/** What opens `thread`'s integrated terminal panel, or undefined when it cannot open. */
export type ThreadTerminalRequest = {
  threadKey: string;
  cwd?: string;
  remote?: IntegratedTerminalPaneRemote;
};

export function threadTerminalRequest(thread: NavigationThreadSummary): ThreadTerminalRequest | undefined {
  if (resolveRemoteTerminalDisabledReason(thread.federation)) return undefined;
  const cwd = thread.federation ? undefined : resolveThreadTerminalCwd(thread);
  const remote = threadTerminalRemote(thread.federation);
  return {
    threadKey: buildThreadIdentityKey(thread.source, thread.id),
    ...(cwd ? { cwd } : {}),
    ...(remote ? { remote } : {}),
  };
}
