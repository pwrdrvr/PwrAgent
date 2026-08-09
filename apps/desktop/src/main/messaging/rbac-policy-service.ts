import {
  BUILT_IN_ROLES,
  isBuiltInRbacRoleId,
  resolveEffectivePermissions,
  roleIsDangerous,
  type MessagingChannelKind,
  type RbacAdmittedVia,
  type RbacAttachment,
  type RbacPolicy,
  type RbacResolution,
  type RbacRoleDefinition,
  type RbacSubject,
  type ReadRbacPolicyResponse,
} from "@pwragent/shared";
import { MESSAGING_PERMISSION_CATALOG } from "@pwragent/shared";

import {
  rbacPolicySourceFingerprint,
  readRbacPolicyState,
  writeRbacPolicy,
  type RbacPolicyReadState,
  type RbacPolicyStoreOptions,
} from "../settings/rbac-policy-store";
import { getDesktopMessagingActivityLog } from "./desktop-messaging-activity-log";
import type { RecordMessagingActivityInput } from "./messaging-activity-log";

/**
 * Per-platform capability resolver injected into each `MessagingController`.
 * The controller stays decoupled from storage — it only asks two questions:
 * "are we enforcing?" and "what may this admitted actor do?".
 */
export interface MessagingRbacPolicyProvider {
  /**
   * False → legacy-compatible mode: every provider-admitted actor is implicitly
   * Admin, exactly as before RBAC shipped. The controller short-circuits its
   * capability checks to allow-all in this mode.
   */
  isEnforcing(): boolean;
  resolve(input: {
    actorId: string;
    conversationId?: string;
    admittedVia?: RbacAdmittedVia;
  }): RbacResolution;
  /**
   * `isEnforcing()` and `resolve()` in ONE policy read — `null` means legacy
   * mode. Every gated action asks both questions, and each separate call
   * re-reads (and re-fingerprints) the policy; the controller is on the inbound
   * hot path and now double-gates most actions (capability + federation scope),
   * so asking separately multiplied the syscalls per message. Optional so an
   * existing provider stub keeps working — callers fall back to the pair.
   */
  resolveIfEnforcing?(input: {
    actorId: string;
    conversationId?: string;
    admittedVia?: RbacAdmittedVia;
  }): RbacResolution | null;
}

/**
 * Best-effort sink for policy-edit audit entries. Injectable so tests can
 * capture entries without a live sqlite state DB behind the singleton log.
 */
export type RbacPolicyAuditSink = (
  entry: RecordMessagingActivityInput,
) => void;

/**
 * Process-wide RBAC policy service. One `[messaging.rbac]` config section
 * backs every platform's controller, so the loaded policy is cached here and
 * invalidated on write.
 */
export class RbacPolicyService {
  private cache: RbacPolicyReadState | null = null;
  /** Fingerprint of the backing files at the time `cache` was loaded. */
  private cacheFingerprint: string | null = null;

  constructor(
    private readonly options?: RbacPolicyStoreOptions,
    private readonly auditSink?: RbacPolicyAuditSink,
  ) {}

  /** Drop the cache so the next read re-loads from disk (call after writes). */
  reload(): void {
    this.cache = null;
    this.cacheFingerprint = null;
  }

  /**
   * The cached policy, re-read whenever the backing files changed underneath
   * us. Our own writes update the cache in place, so the fingerprint check is
   * for edits we did NOT make: a hand-edited `config.toml`, or another app
   * instance sharing this profile. Without it a revoked role kept working in
   * every other instance until restart — revocation that needs a relaunch is
   * not revocation. Each call stats the two backing files, so keep reads
   * coarse: `providerFor` resolves from a single `state()` per authorization
   * rather than one per `allRoles()` / `attachments()`. Still far cheaper than
   * re-parsing the config, but not free — don't sprinkle `state()` on the
   * inbound path.
   */
  private state(): RbacPolicyReadState {
    const fingerprint = rbacPolicySourceFingerprint(this.options);
    if (!this.cache || fingerprint !== this.cacheFingerprint) {
      this.cache = readRbacPolicyState(this.options);
      this.cacheFingerprint = fingerprint;
    }
    return this.cache;
  }

  private policy(): RbacPolicy {
    return this.state().policy;
  }

  isEnforcing(): boolean {
    return this.policy().enforced;
  }

  /** True when the loaded policy is the fail-closed stand-in (unreadable data). */
  isFailClosed(): boolean {
    return this.state().failClosed;
  }

  /** Built-in roles first, then custom roles from the policy file. */
  allRoles(): RbacRoleDefinition[] {
    return [...BUILT_IN_ROLES, ...this.policy().roles];
  }

  attachments(): RbacAttachment[] {
    return this.policy().attachments;
  }

  /** A provider bound to one platform for controller injection. */
  providerFor(platform: MessagingChannelKind): MessagingRbacPolicyProvider {
    // Each arm reads the policy ONCE (`state()` re-fingerprints on every call),
    // so a resolve costs one read instead of one per `allRoles()`/`attachments()`.
    const resolveFrom = (
      policy: RbacPolicy,
      input: {
        actorId: string;
        conversationId?: string;
        admittedVia?: RbacAdmittedVia;
      },
    ): RbacResolution =>
      resolveEffectivePermissions({
        platform,
        actorId: input.actorId,
        conversationId: input.conversationId,
        admittedVia: input.admittedVia,
        roles: [...BUILT_IN_ROLES, ...policy.roles],
        attachments: policy.attachments,
      });
    return {
      isEnforcing: () => this.isEnforcing(),
      resolve: (input) => resolveFrom(this.state().policy, input),
      resolveIfEnforcing: (input) => {
        const { policy } = this.state();
        return policy.enforced ? resolveFrom(policy, input) : null;
      },
    };
  }

  /** The full policy view for the Access Control settings pane. */
  read(): ReadRbacPolicyResponse {
    const state = this.state();
    return {
      enforced: state.policy.enforced,
      roles: this.allRoles(),
      attachments: state.policy.attachments,
      permissionCatalog: MESSAGING_PERMISSION_CATALOG,
      ...(state.failClosed ? { failClosed: true } : {}),
      ...(state.ignoredReservedRoleIds.length > 0
        ? { ignoredReservedRoleIds: [...state.ignoredReservedRoleIds] }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations (used by IPC). Each persists + invalidates the cache.
  // -------------------------------------------------------------------------

  private mutate(next: (policy: RbacPolicy) => RbacPolicy): void {
    const updated = next(structuredClonePolicy(this.policy()));
    writeRbacPolicy(updated, this.options);
    // Adopt the write directly, and re-fingerprint so our own write doesn't
    // read back as an external change on the next resolve.
    this.cache = {
      policy: updated,
      failClosed: false,
      ignoredReservedRoleIds: [],
    };
    this.cacheFingerprint = rbacPolicySourceFingerprint(this.options);
  }

  /**
   * Record a policy-edit audit row (issue #260: the local operator's own
   * Access Control edits are auditable too). Best-effort and fail-soft —
   * an audit failure must never block or roll back a policy write. Allow
   * decisions on the enforcement path are deliberately NOT audited (too
   * noisy); this covers edits, and the controller covers denials.
   */
  private audit(entry: Omit<RecordMessagingActivityInput, "kind">): void {
    try {
      const record =
        this.auditSink
        ?? ((input: RecordMessagingActivityInput) => {
          getDesktopMessagingActivityLog().record(input);
        });
      record({ ...entry, kind: "policy" });
    } catch {
      // Best-effort observability.
    }
  }

  private roleNames(roleIds: readonly string[]): string[] {
    const byId = new Map(this.allRoles().map((role) => [role.id, role.name]));
    return roleIds.map((id) => byId.get(id) ?? id);
  }

  /** Create or update a custom role. Built-in role IDs are reserved. */
  upsertRole(role: RbacRoleDefinition): { ok: boolean; error?: string } {
    if (isBuiltInRoleId(role.id)) {
      return { ok: false, error: "Built-in roles cannot be edited." };
    }
    const danger = roleIsDangerous(role.permissions);
    const previous = this.policy().roles.find(
      (existing) => existing.id === role.id,
    );
    this.mutate((policy) => {
      const roles = policy.roles.filter((existing) => existing.id !== role.id);
      roles.push({
        id: role.id,
        name: role.name,
        ...(role.description ? { description: role.description } : {}),
        builtIn: false,
        ...(danger ? { danger: true } : {}),
        permissions: [...role.permissions],
      });
      return { ...policy, roles };
    });
    this.audit({
      platform: "desktop",
      summary:
        `${previous ? "Updated" : "Created"} role "${role.name}"`
        + ` (${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"})`
        + (danger ? " — includes Codex Full Access" : ""),
      payload: {
        action: previous ? "role-updated" : "role-created",
        roleId: role.id,
        permissions: [...role.permissions],
        ...(previous
          ? { previousPermissions: [...previous.permissions] }
          : {}),
        ...(danger ? { danger: true } : {}),
        editedBy: "local-operator",
      },
    });
    return { ok: true };
  }

  deleteRole(roleId: string): { ok: boolean; error?: string } {
    if (isBuiltInRoleId(roleId)) {
      return { ok: false, error: "Built-in roles cannot be deleted." };
    }
    const previous = this.policy().roles.find((role) => role.id === roleId);
    const detachedFrom = this.policy().attachments.filter((attachment) =>
      attachment.roleIds.includes(roleId),
    ).length;
    this.mutate((policy) => ({
      ...policy,
      roles: policy.roles.filter((role) => role.id !== roleId),
      // Also strip the deleted role from every attachment so no edge dangles.
      attachments: policy.attachments
        .map((attachment) => ({
          ...attachment,
          roleIds: attachment.roleIds.filter((id) => id !== roleId),
        }))
        .filter((attachment) => attachment.roleIds.length > 0),
    }));
    if (previous) {
      this.audit({
        platform: "desktop",
        summary:
          `Deleted role "${previous.name}"`
          + (detachedFrom > 0
            ? ` — detached from ${detachedFrom} subject${detachedFrom === 1 ? "" : "s"}`
            : ""),
        payload: {
          action: "role-deleted",
          roleId,
          permissions: [...previous.permissions],
          detachedSubjects: detachedFrom,
          editedBy: "local-operator",
        },
      });
    }
    return { ok: true };
  }

  /** Upsert an attachment (replaces any existing edge for the same subject). */
  upsertAttachment(attachment: RbacAttachment): { ok: boolean; error?: string } {
    const previous = this.policy().attachments.find((existing) =>
      sameSubject(existing.subject, attachment.subject),
    );
    this.mutate((policy) => {
      const attachments = policy.attachments.filter(
        (existing) => !sameSubject(existing.subject, attachment.subject),
      );
      if (attachment.roleIds.length > 0) {
        attachments.push({
          subject: attachment.subject,
          roleIds: [...attachment.roleIds],
          ...(attachment.displayName
            ? { displayName: attachment.displayName }
            : {}),
        });
      }
      return { ...policy, attachments };
    });
    const displayName = attachment.displayName ?? previous?.displayName;
    const subjectLabel = describeRbacSubject(attachment.subject, displayName);
    this.audit({
      platform: attachment.subject.platform,
      actorId:
        attachment.subject.kind === "actor"
          ? attachment.subject.actorId
          : attachment.subject.bucket,
      ...(displayName ? { actorDisplayName: displayName } : {}),
      summary:
        attachment.roleIds.length > 0
          ? `Roles for ${subjectLabel} set to ${this.roleNames(attachment.roleIds).join(", ")}`
          : `Removed all roles from ${subjectLabel}`,
      payload: {
        action: "attachment-updated",
        subject: { ...attachment.subject },
        roleIds: [...attachment.roleIds],
        ...(previous ? { previousRoleIds: [...previous.roleIds] } : {}),
        editedBy: "local-operator",
      },
    });
    return { ok: true };
  }

  deleteAttachment(subject: RbacSubject): { ok: boolean; error?: string } {
    const previous = this.policy().attachments.find((existing) =>
      sameSubject(existing.subject, subject),
    );
    this.mutate((policy) => ({
      ...policy,
      attachments: policy.attachments.filter(
        (existing) => !sameSubject(existing.subject, subject),
      ),
    }));
    if (previous) {
      this.audit({
        platform: subject.platform,
        actorId: subject.kind === "actor" ? subject.actorId : subject.bucket,
        ...(previous.displayName
          ? { actorDisplayName: previous.displayName }
          : {}),
        summary: `Removed all roles from ${describeRbacSubject(subject, previous.displayName)}`,
        payload: {
          action: "attachment-deleted",
          subject: { ...subject },
          previousRoleIds: [...previous.roleIds],
          editedBy: "local-operator",
        },
      });
    }
    return { ok: true };
  }

  /**
   * Flip enforcement on/off. When enabling for the first time, callers pass a
   * synthesized set of attachments (typically actor→Admin for every currently
   * authorized contact plus bucket review rows) so nobody loses access.
   */
  setEnforced(
    enforced: boolean,
    synthesizedAttachments?: RbacAttachment[],
  ): { ok: boolean; error?: string } {
    const before = this.policy();
    const changed = before.enforced !== enforced;
    const seeded =
      enforced
      && synthesizedAttachments !== undefined
      && before.attachments.length === 0
        ? synthesizedAttachments.length
        : 0;
    this.mutate((policy) => ({
      ...policy,
      enforced,
      attachments:
        synthesizedAttachments && policy.attachments.length === 0
          ? synthesizedAttachments.map((attachment) => ({
              subject: attachment.subject,
              roleIds: [...attachment.roleIds],
              ...(attachment.displayName
                ? { displayName: attachment.displayName }
                : {}),
            }))
          : policy.attachments,
    }));
    if (changed) {
      this.audit({
        platform: "desktop",
        summary: enforced
          ? `Enforcement enabled`
            + (seeded > 0
              ? ` — seeded ${seeded} attachment${seeded === 1 ? "" : "s"}`
              : "")
          : "Enforcement disabled — admitted actors act as Admin",
        payload: {
          action: enforced ? "enforcement-enabled" : "enforcement-disabled",
          ...(seeded > 0 ? { seededAttachments: seeded } : {}),
          editedBy: "local-operator",
        },
      });
    }
    return { ok: true };
  }
}

/**
 * Human label for an audit summary: prefer the friendly display name, fall
 * back to a platform-qualified actor/bucket identifier.
 */
function describeRbacSubject(
  subject: RbacSubject,
  displayName?: string,
): string {
  if (displayName) return displayName;
  if (subject.kind === "actor") {
    return `${subject.platform} user ${subject.actorId}`;
  }
  const bucketLabel =
    subject.bucket === "channel_any_user"
      ? "any-channel-user bucket"
      : "any-workspace-DM bucket";
  return subject.scopeId
    ? `${subject.platform} ${bucketLabel} (${subject.scopeId})`
    : `${subject.platform} ${bucketLabel}`;
}

/**
 * Process-wide singleton. The messaging runtime (read/resolve) and the RBAC IPC
 * handlers (mutations) share one instance so the in-memory cache stays coherent
 * — a policy write updates the cache the runtime's controllers read from.
 */
let sharedService: RbacPolicyService | null = null;

export function getRbacPolicyService(): RbacPolicyService {
  if (!sharedService) {
    sharedService = new RbacPolicyService();
  }
  return sharedService;
}

/** Test-only: drop the singleton so a fresh profile/home can be exercised. */
export function resetRbacPolicyServiceForTests(): void {
  sharedService = null;
}

/** Re-exported under the desktop-local name; one definition lives in shared. */
export function isBuiltInRoleId(roleId: string): boolean {
  return isBuiltInRbacRoleId(roleId);
}

export function sameSubject(a: RbacSubject, b: RbacSubject): boolean {
  if (a.platform !== b.platform || a.kind !== b.kind) return false;
  if (a.kind === "actor" && b.kind === "actor") {
    return a.actorId === b.actorId;
  }
  if (a.kind === "bucket" && b.kind === "bucket") {
    return a.bucket === b.bucket && (a.scopeId ?? null) === (b.scopeId ?? null);
  }
  return false;
}

function structuredClonePolicy(policy: RbacPolicy): RbacPolicy {
  return {
    policyVersion: policy.policyVersion,
    enforced: policy.enforced,
    roles: policy.roles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    attachments: policy.attachments.map((attachment) => ({
      subject: { ...attachment.subject },
      roleIds: [...attachment.roleIds],
      ...(attachment.displayName ? { displayName: attachment.displayName } : {}),
    })),
  };
}
