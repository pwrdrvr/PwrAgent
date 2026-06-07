// Single source of truth for "which discovered ACP instance is active" — used
// by both the discovery/settings path (to mark the active instance + show the
// "Using" badge) and the chat-launch path (to spawn the chosen binary). Keeping
// the precedence in one place means the badge the user sees and the binary that
// actually runs can never disagree. Mirrors PwrSnap's acp-instance-resolver.

import type { AcpAgentInstance, AcpAgentPreference } from "@pwragent/shared";

/**
 * Pick the active instance from a discovered list, honoring the user's
 * preference. Precedence:
 *   1. An override instance (discovery probes the override path and tags it
 *      `source: "override"`), so a manual path wins when it's installed.
 *   2. The user-picked `selectedPath`, when it's still among the instances.
 *   3. The first discovered instance (auto, candidate order: PATH → fallback).
 *
 * Returns `undefined` for an empty list (caller has no installed instance).
 */
export function resolveActiveAcpInstance(
  instances: readonly AcpAgentInstance[],
  pref: AcpAgentPreference | undefined,
): AcpAgentInstance | undefined {
  if (instances.length === 0) {
    return undefined;
  }
  const override = instances.find((inst) => inst.source === "override");
  if (override !== undefined) {
    return override;
  }
  const selected = pref?.selectedPath?.trim();
  if (selected) {
    const match = instances.find((inst) => inst.command === selected);
    if (match !== undefined) {
      return match;
    }
  }
  return instances[0];
}
