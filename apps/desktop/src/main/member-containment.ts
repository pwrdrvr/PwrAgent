import {
  effectiveFederationMemberRole,
  normalizeFederationPeerRole,
  type FederationMemberContainment,
  type FederationPeerRole,
} from "@pwragent/shared";
import { getOwnerHostServices } from "./owner-host";
import type { OwnerApprovals } from "./owner-runtime-policy";
import { OUTPOST_AGENT_TOOL_ALLOWLIST } from "./headless/outpost-agent-tools";
import { getExistingDesktopConfigStore } from "./settings/config-store/desktop-config-store-singleton";
import { isAppStateInitialized } from "./storage/desktop-runtime-storage";
import { desktopFederationState } from "./storage/desktop-federation-storage";

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
 * This instance's own setting. The config store exists once owner services
 * start, before federation or any agent tool runs. A member declares this
 * role to its peers, never the effective one: declaring a containment its
 * gateway assigned would re-tighten a role the gateway's operator relaxed
 * while this member was offline.
 */
export function configuredMemberRole(): FederationPeerRole {
  return resolveMemberRole({
    hostRole: getOwnerHostServices().runtimePolicy?.memberRole,
    configuredRole: getExistingDesktopConfigStore()?.read("federation")?.memberRole,
  });
}

/**
 * The containment this instance enforces: its own setting, tightened by the
 * role its upstream gateway assigns it. Every reader asks again, so the
 * egress guard, agent tools and approvals follow a change without a
 * federation restart.
 */
export function localMemberRole(): FederationPeerRole {
  return effectiveFederationMemberRole(configuredMemberRole(), gatewayAssignedMemberRole());
}

export function localMemberContainment(): FederationMemberContainment {
  const configuredRole = configuredMemberRole();
  const gatewayAssignedRole = gatewayAssignedMemberRole();
  return {
    configuredRole,
    ...(gatewayAssignedRole ? { gatewayAssignedRole } : {}),
    effectiveRole: effectiveFederationMemberRole(configuredRole, gatewayAssignedRole),
  };
}

type GatewayAssignment = { gatewayInstanceId: string; role: FederationPeerRole };

/**
 * How long a read of the gateway's assignment is trusted. Another app
 * instance on this profile may hold the federation lease and record a
 * change, so this process reads the state DB again after this long. The
 * read is one indexed meta lookup, not a commit.
 */
const GATEWAY_ASSIGNMENT_REREAD_MS = 5_000;

/** The last state-DB read; `assignment` null means the gateway has not said. */
let cachedAssignment: { assignment: GatewayAssignment | null; readAt: number } | undefined;

/**
 * The role the upstream gateway assigns this member. It is kept in the state
 * DB so a restarted member is contained before it reconnects, and only for
 * the gateway this member is enrolled with now.
 */
export function gatewayAssignedMemberRole(): FederationPeerRole | undefined {
  return currentGatewayAssignment()?.role;
}

function currentGatewayAssignment(): GatewayAssignment | null | undefined {
  const now = Date.now();
  if (cachedAssignment && now - cachedAssignment.readAt < GATEWAY_ASSIGNMENT_REREAD_MS) return cachedAssignment.assignment;
  if (!isAppStateInitialized()) return cachedAssignment?.assignment;
  // An unreadable state DB keeps the last answer and tries again on the next
  // call. The gateway enforces its own role either way.
  try { cachedAssignment = { assignment: readPersistedGatewayAssignment(), readAt: now }; } catch { /* keep the last answer */ }
  return cachedAssignment?.assignment;
}

function readPersistedGatewayAssignment(): GatewayAssignment | null {
  const raw = desktopFederationState.read("gatewayAssignedRole");
  if (!raw) return null;
  let parsed: { gatewayInstanceId?: unknown; role?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return null; }
  if (typeof parsed.gatewayInstanceId !== "string" || !isEnrolledGateway(parsed.gatewayInstanceId)) return null;
  // A malformed role never widens: normalizeFederationPeerRole reads it as contained.
  return { gatewayInstanceId: parsed.gatewayInstanceId, role: normalizeFederationPeerRole(parsed.role ?? "contained") };
}

/** Without a state DB there is no pairing to check against, as in unit harnesses. */
function isEnrolledGateway(gatewayInstanceId: string): boolean {
  if (!isAppStateInitialized()) return true;
  try { return desktopFederationState.read("gatewayInstanceId") === gatewayInstanceId; } catch { return false; }
}

/**
 * Records what the upstream gateway reported. Writes the state DB only when
 * the role changes, so a reconnect that hears the same role costs nothing.
 * A report from a gateway this member is no longer paired with, such as one
 * that lands while Forget pairing restarts federation, changes nothing.
 * Returns the effective role before and after.
 */
export function recordGatewayAssignedMemberRole(
  gatewayInstanceId: string,
  role: FederationPeerRole,
): { before: FederationPeerRole; after: FederationPeerRole } {
  const before = localMemberRole();
  if (!isEnrolledGateway(gatewayInstanceId)) return { before, after: before };
  const current = currentGatewayAssignment();
  if (current?.gatewayInstanceId !== gatewayInstanceId || current.role !== role) {
    const assignment = { gatewayInstanceId, role };
    if (isAppStateInitialized()) desktopFederationState.write("gatewayAssignedRole", JSON.stringify(assignment));
    cachedAssignment = { assignment, readAt: Date.now() };
  }
  return { before, after: localMemberRole() };
}

/** Forgets the gateway's assignment, with the pairing it belonged to. */
export function clearGatewayAssignedMemberRole(): void {
  // Clear any stored row, including one kept for another gateway: it would
  // otherwise apply again if this member re-pairs with that gateway.
  if (isAppStateInitialized() && desktopFederationState.read("gatewayAssignedRole")) {
    desktopFederationState.write("gatewayAssignedRole", "");
  }
  cachedAssignment = { assignment: null, readAt: Date.now() };
}

/** Drops the in-memory copy so the next read goes back to the state DB, as a restarted process would. */
export function forgetCachedGatewayAssignedMemberRole(): void {
  cachedAssignment = undefined;
}

export function localAgentToolAllowlist(): readonly string[] | undefined {
  return agentToolAllowlistForRole(localMemberRole());
}
