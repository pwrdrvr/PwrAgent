import type { FederationPeerRole } from "@pwragent/shared";
import { getOwnerHostServices } from "./owner-host";
import type { OwnerApprovals } from "./owner-runtime-policy";
import { OUTPOST_AGENT_TOOL_ALLOWLIST } from "./headless/outpost-agent-tools";
import { getExistingDesktopConfigStore } from "./settings/config-store/desktop-config-store-singleton";

/**
 * A federation member's containment, the same concept on a desktop and on an
 * Outpost. A contained member cannot call back into the federation: its own
 * owner refuses the requests it would originate, and its models get only the
 * agent tools in OUTPOST_AGENT_TOOL_ALLOWLIST. A full member has neither
 * limit. Receivers enforce the role the inviter assigned either way
 * (federation-policy.ts); this is the member's own half.
 *
 * The host only supplies the setting: an Outpost from
 * PWRAGENT_OUTPOST_FEDERATION_ROLE, which the operator sets when the
 * container starts, and a desktop from `[federation] member_role` in the
 * profile's config.toml. Whether the host is headless decides nothing.
 */
export function resolveMemberRole(setting: {
  /** The host's operator setting; an Outpost always has one. */
  hostRole?: FederationPeerRole;
  /** `[federation] member_role` in the profile's config.toml. */
  configuredRole?: FederationPeerRole;
}): FederationPeerRole {
  return setting.hostRole ?? setting.configuredRole ?? "full";
}

/** The agent tools a member's models may see and call; undefined means every tool. */
export function agentToolAllowlistForRole(role: FederationPeerRole): readonly string[] | undefined {
  return role === "contained" ? OUTPOST_AGENT_TOOL_ALLOWLIST : undefined;
}

type ApprovalReviewer = "user" | "auto_review";

/**
 * The approval behavior of an execution mode on any host: the mode's own
 * settings, unless the operator turned approvals off. A person reviews a
 * contained member's requests even in Auto: Codex's Auto reviewer falls back
 * to the turn's own model when its catalog has no review model, so a model
 * the operator trusts less would approve its own escalations.
 */
export function approvalSettingsForMode(
  mode: { approvalPolicy: string; approvalsReviewer: ApprovalReviewer },
  member: { approvals?: OwnerApprovals; role: FederationPeerRole },
): { approvalPolicy: string; approvalsReviewer: ApprovalReviewer } {
  if (member.approvals === "never") return { approvalPolicy: "never", approvalsReviewer: "user" };
  return {
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: member.role === "contained" ? "user" : mode.approvalsReviewer,
  };
}

/**
 * This instance's role. The config store exists once owner services start,
 * before federation or any agent tool runs; a desktop that changes
 * `member_role` restarts its federation runtime, which reinstalls the egress
 * guard with the new role.
 */
export function localMemberRole(): FederationPeerRole {
  return resolveMemberRole({
    hostRole: getOwnerHostServices().runtimePolicy?.memberRole,
    configuredRole: getExistingDesktopConfigStore()?.read("federation")?.memberRole,
  });
}

export function localAgentToolAllowlist(): readonly string[] | undefined {
  return agentToolAllowlistForRole(localMemberRole());
}
